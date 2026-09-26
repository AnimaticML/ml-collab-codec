import type { AuthorityOptions, Decision, DecisionRecord, Principal } from "./authority.ts";
import type { Authority } from "./authority.ts";
import { recordOf } from "./authority.ts";
import type { CheckpointBundle } from "./checkpoint.ts";
import { exportCheckpoint, restoreAuthority } from "./checkpoint.ts";

/** What a durable store holds: the last published checkpoint and the decision records after its cut. */
export interface StoredHistory {
  readonly checkpoint: CheckpointBundle | undefined;
  readonly records: readonly DecisionRecord[];
  /** Log position after the last appended record. */
  readonly position: number;
}

/**
 * Storage/ownership port for one document history (v3 §5.8). The host
 * contract: at most one effective writer, enforced by compare-and-commit on
 * the log position plus an owner generation that fences former owners;
 * a decision's state change and receipt are durable together; a
 * checkpoint is staged, then published, and only then is its prefix retired.
 */
export interface DurableStore {
  read(): StoredHistory;
  append(
    expectedPosition: number,
    owner: number,
    record: DecisionRecord,
  ): "committed" | "stale" | "fenced";
  acquire(): number;
  stageCheckpoint(bundle: CheckpointBundle, cutPosition: number): string;
  publishCheckpoint(id: string): void;
  pruneThrough(cutPosition: number): void;
}

export class StaleOwnerError extends Error {}

type Schema = { readonly id: string; readonly version: string };

/**
 * One host's view of a document authority. A losing compare-and-commit
 * reloads checkpoint + tail and re-evaluates the request against the new
 * context; it never appends a stale precomputed candidate.
 */
export class AuthorityHost {
  private constructor(
    private readonly store: DurableStore,
    private readonly schema: Schema,
    private readonly options: AuthorityOptions,
    private current: Authority,
    private position: number,
    private readonly owner: number,
  ) {}

  /** Take ownership (fencing any previous owner) and restore from the store, creating genesis if empty. */
  static open(
    store: DurableStore,
    schema: Schema,
    genesis: () => Authority,
    options: AuthorityOptions = {},
  ): AuthorityHost {
    const owner = store.acquire();
    let stored = store.read();
    if (stored.checkpoint === undefined) {
      const id = store.stageCheckpoint(exportCheckpoint(genesis(), schema), stored.position);
      store.publishCheckpoint(id);
      stored = store.read();
    }
    const authority = AuthorityHost.load(stored, schema, options);
    return new AuthorityHost(store, schema, options, authority, stored.position, owner);
  }

  private static load(stored: StoredHistory, schema: Schema, options: AuthorityOptions): Authority {
    if (stored.checkpoint === undefined)
      throw new StaleOwnerError("store has no published checkpoint");
    return restoreAuthority(stored.checkpoint, stored.records, schema, options);
  }

  get authority(): Authority {
    return this.current;
  }

  private reload(): void {
    const stored = this.store.read();
    this.current = AuthorityHost.load(stored, this.schema, this.options);
    this.position = stored.position;
  }

  submit(request: unknown, principal: Principal, attempts = 4): Decision {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const prepared = this.current.prepare(request, principal);
      const record = recordOf(prepared);
      if (record === undefined) return prepared.decision;
      const result = this.store.append(this.position, this.owner, record);
      if (result === "fenced") throw new StaleOwnerError("another host owns this history");
      if (result === "committed") {
        this.position += 1;
        return this.current.install(prepared);
      }
      this.reload();
    }
    throw new StaleOwnerError("could not commit against a rapidly changing history; retry later");
  }

  /** Stage, publish, then retire the prefix — each step safe to interrupt. */
  checkpoint(retainTransitions = 0): void {
    const id = this.store.stageCheckpoint(
      exportCheckpoint(this.current, this.schema, retainTransitions),
      this.position,
    );
    this.store.publishCheckpoint(id);
    this.store.pruneThrough(this.position);
  }
}
