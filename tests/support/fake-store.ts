import type { DecisionRecord } from "../../src/core/authority.ts";
import type { CheckpointBundle } from "../../src/core/checkpoint.ts";
import type { DurableStore, StoredHistory } from "../../src/core/host.ts";

type Interruption = "stage" | "publish" | "prune" | undefined;

/**
 * An in-memory durable store honouring the host contract: compare-and-commit
 * on the log position, owner fencing, and staged → published → pruned
 * checkpoints. `interrupt` simulates a crash at one checkpoint step.
 */
export class FakeStore implements DurableStore {
  private log: { position: number; record: DecisionRecord }[] = [];
  private appended = 0;
  private owner = 0;
  private published: { bundle: CheckpointBundle; cut: number } | undefined;
  private readonly staged = new Map<string, { bundle: CheckpointBundle; cut: number }>();
  interrupt: Interruption;
  prunedThrough = 0;

  read(): StoredHistory {
    const cut = this.published?.cut ?? 0;
    return {
      checkpoint: this.published === undefined ? undefined : structuredClone(this.published.bundle),
      records: this.log
        .filter((entry) => entry.position > cut)
        .map((entry) => structuredClone(entry.record)),
      position: this.appended,
    };
  }

  append(
    expectedPosition: number,
    owner: number,
    record: DecisionRecord,
  ): "committed" | "stale" | "fenced" {
    if (owner !== this.owner) return "fenced";
    if (expectedPosition !== this.appended) return "stale";
    this.appended += 1;
    this.log.push({ position: this.appended, record: structuredClone(record) });
    return "committed";
  }

  /** The current owner generation (lets a test play a second handler of the same owner). */
  currentOwner(): number {
    return this.owner;
  }

  acquire(): number {
    this.owner += 1;
    return this.owner;
  }

  stageCheckpoint(bundle: CheckpointBundle, cutPosition: number): string {
    if (this.interrupt === "stage") throw new Error("crash while staging");
    const id = `cp-${this.staged.size + 1}`;
    this.staged.set(id, { bundle: structuredClone(bundle), cut: cutPosition });
    return id;
  }

  publishCheckpoint(id: string): void {
    if (this.interrupt === "publish") throw new Error("crash before publication");
    const staged = this.staged.get(id);
    if (staged === undefined) throw new Error(`unknown checkpoint ${id}`);
    this.published = staged;
  }

  pruneThrough(cutPosition: number): void {
    if (this.interrupt === "prune") throw new Error("crash during cleanup");
    if ((this.published?.cut ?? -1) < cutPosition)
      throw new Error("refusing to prune past the published checkpoint");
    this.log = this.log.filter((entry) => entry.position > cutPosition);
    this.prunedThrough = cutPosition;
  }

  /** Physical records still retained (for asserting that a prefix was retired). */
  retainedRecords(): number {
    return this.log.length;
  }
}
