/**
 * Replica-scoped request identity (v3 §5.4). A replica incarnation id is a
 * bounded ASCII token compared bytewise; request/origin sequences are JSON
 * safe integers compared numerically. Neither is a clock, an author, a
 * connection, or a server-assigned revision.
 */
const REPLICA_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export function isReplicaId(value: unknown): value is string {
  return typeof value === "string" && REPLICA_PATTERN.test(value);
}

export interface RequestId {
  readonly replica: string;
  readonly seq: number;
}

export function requestKey(id: RequestId): string {
  return `${id.replica}#${id.seq}`;
}

export function sameRequest(a: RequestId, b: RequestId): boolean {
  return a.replica === b.replica && a.seq === b.seq;
}

export function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export class IdentityError extends Error {}

/** Durable allocator state: the last sequence handed out by this incarnation. */
export interface AllocatorState {
  readonly replica: string;
  readonly lastSeq: number;
}

/** Injected persistence port (browser storage, a file, a test fake). */
export interface AllocatorStore {
  load(): unknown;
  save(state: AllocatorState): void;
}

/**
 * Allocates strictly increasing sequences for one replica incarnation
 * without any server round trip. Each allocation is persisted before it is
 * returned (write-ahead), so a crash can create a gap but never reuse a
 * sequence. Lost state means a fresh incarnation, never a restarted counter.
 */
export class SequenceAllocator {
  private constructor(
    private readonly store: AllocatorStore,
    readonly replica: string,
    private lastSeq: number,
  ) {}

  static open(store: AllocatorStore, newIncarnation: () => string): SequenceAllocator {
    const loaded = store.load();
    if (loaded === undefined || loaded === null) {
      const replica = newIncarnation();
      if (!isReplicaId(replica))
        throw new IdentityError(`invalid replica incarnation id ${String(replica)}`);
      store.save({ replica, lastSeq: 0 });
      return new SequenceAllocator(store, replica, 0);
    }
    const state = loaded as Partial<AllocatorState>;
    if (!isReplicaId(state.replica))
      throw new IdentityError("stored allocator has a malformed replica id");
    const last = state.lastSeq;
    if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0)
      throw new IdentityError("stored allocator has a malformed sequence");
    return new SequenceAllocator(store, state.replica, last);
  }

  /** In-memory allocator for tests and ephemeral sessions. */
  static ephemeral(replica: string, lastSeq = 0): SequenceAllocator {
    if (!isReplicaId(replica))
      throw new IdentityError(`invalid replica incarnation id ${String(replica)}`);
    const memory: AllocatorStore = { load: () => ({ replica, lastSeq }), save: () => undefined };
    return SequenceAllocator.open(memory, () => replica);
  }

  get last(): number {
    return this.lastSeq;
  }

  next(): number {
    if (this.lastSeq >= MAX_SEQUENCE)
      throw new IdentityError("request sequence space exhausted; start a new incarnation");
    const seq = this.lastSeq + 1;
    this.store.save({ replica: this.replica, lastSeq: seq });
    this.lastSeq = seq;
    return seq;
  }
}
