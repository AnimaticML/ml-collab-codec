import type { Change } from "./change.ts";
import type { RequestId } from "./identity.ts";
import type { ChangeSummary } from "./summary.ts";
import { isEmptySummary, summarize } from "./summary.ts";
import type { Table } from "./table.ts";

/** Read-only published state. The same object is returned until visible content changes. */
export interface DocumentSnapshot {
  readonly table: Table;
  /** Local visible content revision (publication counter), not a server revision. */
  readonly contentRevision: number;
  readonly documentId: string;
  readonly historyEpoch: string;
  /** Confirmed context and pending local requests this content was computed from. */
  readonly basis: { readonly confirmedRevision: number; readonly pending: readonly RequestId[] };
}

export type CommitCause = "local" | "remote" | "reconcile" | "undo" | "redo" | "restore";

export interface ModelCommit {
  readonly previous: DocumentSnapshot;
  readonly next: DocumentSnapshot;
  readonly publicationId: string;
  readonly changes: ChangeSummary;
  /** Address mapping from `previous` to `next` as reversible primitives (anchors map through it). */
  readonly mapping: readonly Change[];
  readonly cause: CommitCause;
}

/** Protocol/history bookkeeping that does not change visible content (acks, receipts, retained intent). */
export interface StatusEvent {
  readonly confirmedRevision: number;
  readonly pending: readonly RequestId[];
  readonly notes: readonly string[];
  /** Content-equal address mapping (e.g. delete and re-insert of equal text), for anchor services. */
  readonly mapping: readonly Change[];
}

export interface DocumentStore {
  getSnapshot(): DocumentSnapshot;
  subscribeCommits(listener: (commit: ModelCommit) => void): () => void;
}

interface Staged {
  table: Table;
  basis: DocumentSnapshot["basis"];
  mapping: Change[];
  cause: CommitCause;
  status: StatusEvent | undefined;
  fullResync: boolean;
}

/**
 * Publication boundary (v3 §4.2): internal steps stage privately; one
 * coherent commit is delivered when the outermost batch ends. Subscriber
 * failures go to an error channel and never uncommit state; mutations
 * requested during delivery run afterwards as later batches.
 */
export class Publisher implements DocumentStore {
  private snapshot: DocumentSnapshot;
  private staged: Staged | undefined;
  private depth = 0;
  private delivering = false;
  private readonly deferred: (() => void)[] = [];
  private readonly commitListeners = new Set<(commit: ModelCommit) => void>();
  private readonly statusListeners = new Set<(status: StatusEvent) => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private publications = 0;

  constructor(initial: DocumentSnapshot) {
    this.snapshot = initial;
  }

  getSnapshot(): DocumentSnapshot {
    return this.snapshot;
  }

  subscribeCommits(listener: (commit: ModelCommit) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  subscribeStatus(listener: (status: StatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  subscribeErrors(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** True while listeners are being called; writes must be deferred. */
  isDelivering(): boolean {
    return this.delivering;
  }

  /** Run `task` after the current delivery (or now, when not delivering). */
  defer(task: () => void): void {
    if (this.delivering) this.deferred.push(task);
    else task();
  }

  /** Run `work` as one publication batch; nested batches join the outer one. Failures discard the stage. */
  batch<T>(cause: CommitCause, work: () => T): T {
    if (this.depth === 0)
      this.staged = {
        table: this.snapshot.table,
        basis: this.snapshot.basis,
        mapping: [],
        cause,
        status: undefined,
        fullResync: false,
      };
    this.depth += 1;
    let completed = false;
    try {
      const result = work();
      completed = true;
      return result;
    } finally {
      this.depth -= 1;
      if (this.depth === 0) {
        const staged = this.staged;
        this.staged = undefined;
        if (completed && staged !== undefined) this.publish(staged);
      }
    }
  }

  private current(): Staged {
    if (this.staged === undefined) throw new Error("publisher: stage outside a batch");
    return this.staged;
  }

  /** Stage new visible content reached through `mapping` from the previous staged content. */
  stage(table: Table, mapping: readonly Change[], cause?: CommitCause): void {
    const staged = this.current();
    staged.table = table;
    staged.mapping.push(...mapping);
    if (cause !== undefined && staged.cause === "local") staged.cause = cause;
  }

  /** Stage content reached without a primitive mapping (restore): subscribers get a full-resync summary. */
  stageRestore(table: Table): void {
    const staged = this.current();
    staged.table = table;
    staged.fullResync = true;
    staged.cause = "restore";
  }

  stageStatus(status: Omit<StatusEvent, "mapping">, basis: DocumentSnapshot["basis"]): void {
    const staged = this.current();
    staged.status = { ...status, mapping: [] };
    staged.basis = basis;
  }

  private publish(staged: Staged): void {
    const previous = this.snapshot;
    const summary = summarize(previous.table, staged.table, staged.mapping, staged.fullResync);
    const contentChanged = staged.table !== previous.table && !isEmptySummary(summary);
    if (contentChanged) {
      this.publications += 1;
      this.snapshot = {
        ...previous,
        table: staged.table,
        contentRevision: previous.contentRevision + 1,
        basis: staged.basis,
      };
      const commit: ModelCommit = {
        previous,
        next: this.snapshot,
        publicationId: `pub-${this.publications}`,
        changes: summary,
        mapping: staged.mapping,
        cause: staged.cause,
      };
      this.deliver(this.commitListeners, commit);
    }
    const silentMapping = contentChanged ? [] : staged.mapping;
    if (staged.status !== undefined || silentMapping.length > 0) {
      const status = staged.status ?? {
        confirmedRevision: staged.basis.confirmedRevision,
        pending: staged.basis.pending,
        notes: [],
        mapping: [],
      };
      this.deliver(this.statusListeners, { ...status, mapping: silentMapping });
    }
  }

  private deliver<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    const outer = this.delivering;
    this.delivering = true;
    try {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          for (const onError of [...this.errorListeners]) onError(error);
        }
      }
    } finally {
      this.delivering = outer;
    }
    if (!outer) while (this.deferred.length > 0) this.deferred.shift()?.();
  }
}
