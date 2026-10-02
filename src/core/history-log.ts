import type { LogEntry } from "./history-recovery.ts";
import { cancelPairs } from "./history-recovery.ts";

/** The serialized recovery log: transitions after revision `start`, oldest first. */
export interface RecoveryLogExport {
  readonly start: number;
  readonly entries: readonly LogEntry[];
}

/** Whether an entry is an own undo or redo, the only transitions that can cancel earlier ones. */
export function cancels(entry: LogEntry): boolean {
  return entry.own !== undefined && entry.own.kind !== "do";
}

/** Fold a sequence in order, cancelling at each own undo/redo as it arrives. */
function reduce(entries: readonly LogEntry[]): LogEntry[] {
  let reduced: LogEntry[] = [];
  for (const entry of entries) {
    reduced.push(entry);
    if (cancels(entry)) reduced = cancelPairs(reduced) ?? reduced;
  }
  return reduced;
}

/**
 * Accepted transitions shared by every degraded undo/redo handle. Each
 * transition is stored once, however many handles need it; the history
 * trims it to the oldest context a retained handle can still recover from.
 * `limit` optionally caps the retained transitions (default: unbounded,
 * so recovery is bounded only by the retained groups, `undoLimit`).
 */
export class RecoveryLog {
  private entries: LogEntry[] = [];
  private reduced = new Map<number, LogEntry[]>();

  constructor(
    private start: number,
    private readonly limit = Infinity,
  ) {
    if (!(limit >= 0)) throw new RangeError("recoveryLimit must be a non-negative number");
  }

  static restore(data: RecoveryLogExport, limit?: number): RecoveryLog {
    const log = new RecoveryLog(data.start, limit);
    log.entries = [...data.entries];
    return log;
  }

  export(): RecoveryLogExport {
    return { start: this.start, entries: [...this.entries] };
  }

  append(entry: LogEntry): void {
    this.entries.push(entry);
    this.reduced.clear();
  }

  /** Whether the transitions after revision `from` are all still retained. */
  covers(from: number): boolean {
    return from >= this.start;
  }

  /** Transitions after revision `from` with cancelled own pairs removed (computed once per `from`). */
  reducedAfter(from: number): LogEntry[] | undefined {
    if (!this.covers(from)) return undefined;
    const cached = this.reduced.get(from);
    if (cached !== undefined) return cached;
    const result = reduce(this.entries.filter((entry) => entry.revision > from));
    this.reduced.set(from, result);
    return result;
  }

  /** Keep only transitions after `oldest` (the oldest context still needed), then apply the cap. */
  retain(oldest: number | undefined, current: number): void {
    let keepAfter = Math.max(this.start, oldest ?? current);
    let drop = 0;
    while (drop < this.entries.length && (this.entries[drop] as LogEntry).revision <= keepAfter)
      drop += 1;
    const excess = this.entries.length - drop - this.limit;
    if (excess > 0) {
      drop += excess;
      keepAfter = (this.entries[drop - 1] as LogEntry).revision;
    }
    this.start = keepAfter;
    if (drop === 0) return;
    this.entries.splice(0, drop);
    this.reduced.clear();
  }
}
