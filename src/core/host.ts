import type { AuthorityOptions, Decision, DecisionRecord, Principal } from "./authority.ts";
import type { Authority } from "./authority.ts";
import { recordOf } from "./authority.ts";
import type { CheckpointBundle } from "./checkpoint.ts";
import { exportCheckpoint, restoreAuthority } from "./checkpoint.ts";
import type { SchemaRef } from "./client-types.ts";
import type { TransitionEvent } from "./protocol.ts";
import type { SchemaProfile } from "./schema.ts";

/** What a durable store holds: the last published checkpoint and the decision records after its cut. */
export interface StoredHistory {
  readonly checkpoint: CheckpointBundle | undefined;
  readonly records: readonly DecisionRecord[];
  /** Log position after the last appended record. */
  readonly position: number;
}

/**
 * Asynchronous storage/ownership port for one document history (v3 §5.8,
 * MR39/MR40). Contract a store must provide:
 * - `append` is compare-and-commit on the log position and fenced by the
 *   owner generation: a record is durable, together with its receipt, before
 *   the promise resolves `committed`; a former owner gets `fenced`.
 * - `acquire` returns a new owner generation, fencing every earlier one.
 * - Checkpoint steps are owner-fenced; `publishCheckpoint` never replaces a
 *   published checkpoint with one whose cut is older (`superseded`);
 *   `pruneThrough` refuses a cut beyond the published checkpoint.
 * A rejected promise means the outcome is unknown; the host reloads before
 * deciding anything else.
 */
export interface DurableStore {
  read(): Promise<StoredHistory>;
  append(
    expectedPosition: number,
    owner: number,
    record: DecisionRecord,
  ): Promise<"committed" | "stale" | "fenced">;
  acquire(): Promise<number>;
  stageCheckpoint(
    bundle: CheckpointBundle,
    cutPosition: number,
    owner: number,
  ): Promise<{ readonly staged: string } | "fenced">;
  publishCheckpoint(id: string, owner: number): Promise<"published" | "superseded" | "fenced">;
  pruneThrough(cutPosition: number, owner: number): Promise<"pruned" | "refused" | "fenced">;
}

export class StaleOwnerError extends Error {}

/**
 * One host's view of a document authority. Work is serialized: one
 * submission or checkpoint at a time, each awaiting durable storage before
 * anything is installed or announced. A losing compare-and-commit, or an
 * append whose outcome is unknown, reloads checkpoint + tail and
 * re-evaluates against the new context; a stale precomputed candidate is
 * never installed.
 */
export class AuthorityHost {
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private readonly listeners = new Set<(transition: TransitionEvent) => void>();

  private constructor(
    private readonly store: DurableStore,
    private readonly schema: SchemaRef | SchemaProfile,
    private readonly options: AuthorityOptions,
    private current: Authority,
    private position: number,
    private readonly owner: number,
  ) {
    this.forward(current);
  }

  private forward(authority: Authority): void {
    authority.subscribe((transition) => {
      for (const listener of [...this.listeners]) listener(transition);
    });
  }

  /**
   * Observe accepted transitions in revision order, across reloads: those
   * this host installs, and those another handler committed that a reload
   * picked up (while they are retained).
   */
  subscribe(listener: (transition: TransitionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Take ownership (fencing any previous owner) and restore from the store, creating genesis if empty. */
  static async open(
    store: DurableStore,
    schema: SchemaRef | SchemaProfile,
    genesis: () => Authority,
    options: AuthorityOptions = {},
  ): Promise<AuthorityHost> {
    const owner = await store.acquire();
    let stored = await store.read();
    if (stored.checkpoint === undefined) {
      const bundle = exportCheckpoint(genesis(), schema);
      const staged = await store.stageCheckpoint(bundle, stored.position, owner);
      if (staged === "fenced" || (await store.publishCheckpoint(staged.staged, owner)) === "fenced")
        throw new StaleOwnerError("another host took ownership while opening");
      stored = await store.read();
    }
    const authority = AuthorityHost.load(stored, schema, options);
    return new AuthorityHost(store, schema, options, authority, stored.position, owner);
  }

  private static load(
    stored: StoredHistory,
    schema: SchemaRef | SchemaProfile,
    options: AuthorityOptions,
  ): Authority {
    if (stored.checkpoint === undefined)
      throw new StaleOwnerError("store has no published checkpoint");
    return restoreAuthority(stored.checkpoint, stored.records, schema, options);
  }

  /** The current installed authority (read-only use; submit through the host). */
  get authority(): Authority {
    return this.current;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reload(): Promise<void> {
    const stored = await this.store.read();
    const previous = this.current.getRevision();
    this.current = AuthorityHost.load(stored, this.schema, this.options);
    this.position = stored.position;
    this.dirty = false;
    const missed = this.current.transitionsSince(previous) ?? [];
    this.forward(this.current);
    for (const transition of missed)
      for (const listener of [...this.listeners]) listener(transition);
  }

  submit(request: unknown, principal: Principal, attempts = 4): Promise<Decision> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (this.dirty) await this.reload();
        const prepared = this.current.prepare(request, principal);
        const record = recordOf(prepared);
        if (record === undefined) return prepared.decision;
        this.dirty = true; // Until the append resolves, the durable outcome is unknown.
        const result = await this.store.append(this.position, this.owner, record);
        if (result === "fenced") throw new StaleOwnerError("another host owns this history");
        if (result === "committed") {
          this.dirty = false;
          this.position += 1;
          return this.current.install(prepared);
        }
      }
      throw new StaleOwnerError("could not commit against a rapidly changing history; retry later");
    });
  }

  /** Stage, publish, then retire the prefix — each step owner-fenced and safe to interrupt. */
  checkpoint(retainTransitions = 0): Promise<void> {
    return this.serialized(async () => {
      if (this.dirty) await this.reload();
      const cut = this.position;
      const bundle = exportCheckpoint(this.current, this.schema, retainTransitions);
      const staged = await this.store.stageCheckpoint(bundle, cut, this.owner);
      const published =
        staged === "fenced"
          ? "fenced"
          : await this.store.publishCheckpoint(staged.staged, this.owner);
      if (published === "fenced") throw new StaleOwnerError("another host owns this history");
      if (published === "superseded") return;
      if ((await this.store.pruneThrough(cut, this.owner)) === "fenced")
        throw new StaleOwnerError("another host owns this history");
    });
  }
}
