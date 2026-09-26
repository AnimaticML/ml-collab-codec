import type { DecisionRecord } from "../../src/core/authority.ts";
import type { CheckpointBundle } from "../../src/core/checkpoint.ts";
import type { DurableStore, StoredHistory } from "../../src/core/host.ts";

type Step = "append" | "stage" | "publish" | "prune";

/**
 * Test hooks: `gate` holds a step until the test releases it (delayed I/O,
 * interleavings); `fail` makes a step reject, either before anything is
 * written or after the write with a lost acknowledgement.
 */
interface StoreHooks {
  gate?: (step: Step) => Promise<void> | undefined;
  fail?: (step: Step) => "before" | "after" | undefined;
}

/**
 * An in-memory asynchronous durable store honouring the host contract:
 * compare-and-commit on the log position, owner fencing on every write,
 * checkpoints that are staged, then published (never replaced by an older
 * cut), then pruned only up to the published cut.
 */
export class FakeStore implements DurableStore {
  private log: { position: number; record: DecisionRecord }[] = [];
  private appended = 0;
  private owner = 0;
  private published: { bundle: CheckpointBundle; cut: number } | undefined;
  private readonly staged = new Map<string, { bundle: CheckpointBundle; cut: number }>();
  hooks: StoreHooks = {};
  prunedThrough = 0;

  private async enter(step: Step): Promise<void> {
    await this.hooks.gate?.(step);
    if (this.hooks.fail?.(step) === "before") throw new Error(`I/O failure before ${step}`);
  }

  private leave(step: Step): void {
    if (this.hooks.fail?.(step) === "after") throw new Error(`acknowledgement of ${step} lost`);
  }

  read(): Promise<StoredHistory> {
    const cut = this.published?.cut ?? 0;
    return Promise.resolve({
      checkpoint: this.published === undefined ? undefined : structuredClone(this.published.bundle),
      records: this.log
        .filter((entry) => entry.position > cut)
        .map((entry) => structuredClone(entry.record)),
      position: this.appended,
    });
  }

  async append(
    expectedPosition: number,
    owner: number,
    record: DecisionRecord,
  ): Promise<"committed" | "stale" | "fenced"> {
    await this.enter("append");
    if (owner !== this.owner) return "fenced";
    if (expectedPosition !== this.appended) return "stale";
    this.appended += 1;
    this.log.push({ position: this.appended, record: structuredClone(record) });
    this.leave("append");
    return "committed";
  }

  /** The current owner generation (lets a test play a second handler of the same owner). */
  currentOwner(): number {
    return this.owner;
  }

  acquire(): Promise<number> {
    this.owner += 1;
    return Promise.resolve(this.owner);
  }

  async stageCheckpoint(
    bundle: CheckpointBundle,
    cutPosition: number,
    owner: number,
  ): Promise<{ readonly staged: string } | "fenced"> {
    await this.enter("stage");
    if (owner !== this.owner) return "fenced";
    const id = `cp-${this.staged.size + 1}`;
    this.staged.set(id, { bundle: structuredClone(bundle), cut: cutPosition });
    return { staged: id };
  }

  async publishCheckpoint(
    id: string,
    owner: number,
  ): Promise<"published" | "superseded" | "fenced"> {
    await this.enter("publish");
    if (owner !== this.owner) return "fenced";
    const staged = this.staged.get(id);
    if (staged === undefined) throw new Error(`unknown checkpoint ${id}`);
    if (this.published !== undefined && staged.cut < this.published.cut) return "superseded";
    this.published = staged;
    this.leave("publish");
    return "published";
  }

  async pruneThrough(cutPosition: number, owner: number): Promise<"pruned" | "refused" | "fenced"> {
    await this.enter("prune");
    if (owner !== this.owner) return "fenced";
    if ((this.published?.cut ?? -1) < cutPosition) return "refused";
    this.log = this.log.filter((entry) => entry.position > cutPosition);
    this.prunedThrough = cutPosition;
    return "pruned";
  }

  /** Physical records still retained (for asserting that a prefix was retired). */
  retainedRecords(): number {
    return this.log.length;
  }

  /**
   * Hold the next `step` until released; `arrived` resolves once the host
   * reaches it (deterministic interleavings without timers).
   */
  pause(step: Step): { arrived: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let arrive = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    let pending = true;
    this.hooks = {
      ...this.hooks,
      gate: (current) => {
        if (current !== step || !pending) return undefined;
        pending = false;
        arrive();
        return held;
      },
    };
    return { arrived, release };
  }

  /** Cut of the published checkpoint. */
  publishedCut(): number | undefined {
    return this.published?.cut;
  }
}
