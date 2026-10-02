import type { Change } from "./change.ts";
import { invertChanges } from "./change.ts";
import { canonicalJson } from "./change-codec.ts";
import { compose } from "./compose.ts";
import { isConflict, transformPair } from "./transform.ts";

/** Complete reversible primitives in the client's confirmed context, with how many contributions lost effect. */
export interface CleanHandle {
  readonly changes: readonly Change[];
  readonly dropped: number;
}

/**
 * An accepted transition in the recovery log. `own` tags this replica's
 * transitions that applied (`do`), cancelled (`undo`) or reapplied (`redo`)
 * one of its groups; only those can later be cancelled out.
 */
export interface LogEntry {
  readonly revision: number;
  readonly changes: readonly Change[];
  readonly own?: { readonly group: string; readonly kind: "do" | "undo" | "redo" };
}

/**
 * How a degraded handle may become usable again: its last clean form,
 * valid at revision `from`. The accepted transitions after `from` live once
 * in the history's shared `RecoveryLog`.
 */
export interface Recovery {
  readonly base: CleanHandle;
  readonly from: number;
}

const POSITIONS = new Set(["offset", "index", "from", "gap", "fromIndex"]);

/**
 * Whether two primitives differ beyond positions: mapping that only shifts
 * positions loses nothing. Fields are compared by reference, so a payload a
 * transform rebuilt counts as changed (conservatively keeping recovery).
 */
function reshaped(before: Change, after: Change): boolean {
  if (before === after) return false;
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  for (const key in b) if (!POSITIONS.has(key) && a[key] !== b[key]) return true;
  for (const key in a) if (!(key in b)) return true;
  return false;
}

/**
 * Whether mapping turned `before` into a handle that lost something: a
 * conflict, a dropped contribution, or a primitive whose content (not just
 * position) changed, such as a deletion shortened by a later deletion.
 */
export function degraded(
  before: CleanHandle,
  after: CleanHandle | { readonly conflict: string },
): boolean {
  if ("conflict" in after) return true;
  return (
    after.dropped > before.dropped ||
    after.changes.length !== before.changes.length ||
    after.changes.some((change, index) => reshaped(before.changes[index] as Change, change))
  );
}

type Mapped = CleanHandle & { readonly incoming: readonly Change[] };

/** Map each primitive past `incoming` in order; `incoming` comes out excluding the mapped changes. */
export function mapChanges(
  handle: CleanHandle,
  incoming: readonly Change[],
): Mapped | { readonly conflict: string } {
  const mapped: Change[] = [];
  let dropped = handle.dropped;
  for (const change of handle.changes) {
    const pair = transformPair([change], incoming);
    if (isConflict(pair)) return { conflict: pair.detail };
    if (pair.a.length === 0) dropped += 1;
    mapped.push(...pair.a);
    incoming = pair.b;
  }
  return { changes: mapped, dropped, incoming };
}

/** Map a clean handle over a sequence of accepted transitions. */
export function mapOver(
  base: CleanHandle,
  entries: readonly LogEntry[],
): CleanHandle | { readonly conflict: string } {
  let handle = base;
  for (const entry of entries) {
    const next = mapChanges(handle, entry.changes);
    if ("conflict" in next) return next;
    handle = { changes: next.changes, dropped: next.dropped };
  }
  return handle;
}

/**
 * Remove `entries[index]` from the sequence: its inverse is carried forward
 * through every later entry, which comes out in the context without it.
 * By TP1, `C · X₁…Xₙ · inverse′ ≡ X₁′…Xₙ′`.
 */
function exclude(
  entries: readonly LogEntry[],
  index: number,
): { readonly inverse: readonly Change[]; readonly after: LogEntry[] } | undefined {
  let inverse: readonly Change[] = invertChanges((entries[index] as LogEntry).changes);
  const after: LogEntry[] = [];
  for (const entry of entries.slice(index + 1)) {
    const next = mapChanges({ changes: inverse, dropped: 0 }, entry.changes);
    if ("conflict" in next) return undefined;
    inverse = next.changes;
    after.push({ ...entry, changes: next.incoming });
  }
  return { inverse, after };
}

/**
 * A record's effect for verification. Assignments and deltas never consult
 * their origin (no placement ties; their inverses are assignments and
 * deltas again), and which origin survives a chain that passes through a
 * net-zero point depends on composition order, so it is left out for them.
 */
function effect(change: Change): string {
  if (change.kind !== "set" && change.kind !== "delta") return canonicalJson(change);
  const { origin: _origin, ...rest } = change;
  return canonicalJson(rest);
}

/** Whether `changes` begins with exactly the effects of `prefix`. */
function beginsWith(changes: readonly Change[], prefix: readonly Change[]): boolean {
  return (
    prefix.length <= changes.length &&
    prefix.every((change, index) => effect(change) === effect(changes[index] as Change))
  );
}

/** Whether `entry` is an effect that `last` (an own undo or redo) cancels, ends the search, or neither. */
function relation(last: LogEntry, entry: LogEntry): "cancels" | "stop" | "skip" {
  const own = entry.own;
  if (own === undefined || last.own === undefined || own.group !== last.own.group) return "skip";
  const cancels = last.own.kind === "undo" ? own.kind !== "undo" : own.kind === "undo";
  return cancels ? "cancels" : "stop";
}

/**
 * Cancel the newest entry — an own undo or redo — against the effects of
 * its group earlier in the sequence, latest first. Removing each effect
 * carries its inverse forward; the carried inverses, composed in undo order,
 * must be exactly how the accepted undo/redo begins (members are composed in
 * the handle the same way), otherwise nothing is cancelled. The unmatched
 * remainder (effects absorbed before the sequence) stays as an entry.
 * Returns undefined when nothing was cancelled.
 */
export function cancelPairs(entries: readonly LogEntry[]): LogEntry[] | undefined {
  const last = entries[entries.length - 1];
  if (last?.own === undefined || last.own.kind === "do") return undefined;
  const log = entries.slice(0, -1);
  let inverse: Change[] = [];
  let cancelled = false;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const kind = relation(last, log[index] as LogEntry);
    if (kind === "skip") continue;
    const excluded = kind === "cancels" ? exclude(log, index) : undefined;
    if (excluded === undefined) break;
    inverse = compose(inverse, excluded.inverse);
    log.length = index;
    for (const entry of excluded.after) log.push(entry);
    cancelled = true;
    if (last.own.kind === "redo") break;
  }
  if (!cancelled || !beginsWith(last.changes, inverse)) return undefined;
  const rest = last.changes.slice(inverse.length);
  return rest.length === 0 ? log : [...log, { ...last, changes: rest }];
}
