import type { Change } from "./change.ts";
import { invertChanges } from "./change.ts";
import type { EditShape } from "./grouping.ts";
import type { RequestId } from "./identity.ts";
import { requestKey } from "./identity.ts";
import type { RequestEnvelope, RequestMeta } from "./protocol.ts";
import { isConflict, transformPair } from "./transform.ts";

/**
 * One local request (v3 §5.5). `meta` preserves the authored context and
 * stable source origins; `submitted` is the immutable sent form; `working`
 * is the current form in the context "confirmed + preceding working forms".
 * A `doomed` entry is in flight but known to conflict; it stays out of the
 * visible chain until its receipt arrives.
 */
export interface PendingEntry {
  readonly id: RequestId;
  readonly meta: RequestMeta;
  readonly working: readonly Change[];
  readonly shape: EditShape;
  readonly state: "unsent" | "inFlight" | "doomed";
  readonly submitted?: RequestEnvelope;
}

export type RetainedStatus = "rejected" | "blocked" | "conflict" | "resync";

/** Local intent kept for review/retry; it is never silently applied or discarded. */
export interface RetainedIntent {
  readonly id: RequestId;
  readonly meta: RequestMeta;
  readonly working: readonly Change[];
  readonly status: RetainedStatus;
  readonly reason: string;
}

export type Exclusion =
  | { readonly kind: "drop" }
  | { readonly kind: "retain"; readonly status: RetainedStatus; readonly reason: string };

interface ReconcileResult {
  readonly pending: readonly PendingEntry[];
  readonly retained: readonly RetainedIntent[];
  /** The incoming change mapped past every surviving entry (for the forward path). */
  readonly incoming: readonly Change[];
  /** True when any entry left the visible chain; visible state must then be recomputed. */
  readonly excluded: boolean;
}

function retain(entry: PendingEntry, status: RetainedStatus, reason: string): RetainedIntent {
  return { id: entry.id, meta: entry.meta, working: entry.working, status, reason };
}

/**
 * Walk the dependent pending chain once: remove explicitly excluded entries
 * (rebasing later entries over their inverse, blocking true dependents) and
 * pair every survivor with the incoming accepted change, advancing both.
 * An in-flight entry that cannot be rebased becomes `doomed` (the authority
 * will decide it); unsent ones are retained as conflicts.
 */
export function reconcile(
  pending: readonly PendingEntry[],
  incoming: readonly Change[],
  exclusions: ReadonlyMap<string, Exclusion> = new Map(),
): ReconcileResult {
  let removal: Change[] = [];
  let x = incoming;
  let excluded = false;
  const next: PendingEntry[] = [];
  const retained: RetainedIntent[] = [];
  const drop = (
    entry: PendingEntry,
    status: RetainedStatus,
    reason: string,
    before: Change[],
  ): void => {
    removal = [...invertChanges(entry.working), ...before];
    excluded = true;
    if (entry.state === "inFlight") next.push({ ...entry, state: "doomed" });
    else retained.push(retain(entry, status, reason));
  };
  for (const entry of pending) {
    if (entry.state === "doomed") {
      next.push(entry);
      continue;
    }
    const explicit = exclusions.get(requestKey(entry.id));
    if (explicit !== undefined) {
      removal = [...invertChanges(entry.working), ...removal];
      excluded = true;
      if (explicit.kind === "retain")
        retained.push(retain(entry, explicit.status, explicit.reason));
      continue;
    }
    const before = removal;
    let working = entry.working;
    if (removal.length > 0) {
      const rebased = transformPair(working, removal);
      if (isConflict(rebased)) {
        drop(entry, "blocked", "depends on an excluded local change", before);
        continue;
      }
      working = rebased.a;
      removal = [...rebased.b];
    }
    if (x.length > 0) {
      const paired = transformPair(working, x);
      if (isConflict(paired)) {
        drop(entry, "conflict", `conflicts with accepted work: ${paired.conflict}`, before);
        continue;
      }
      working = paired.a;
      x = paired.b;
    }
    next.push({ ...entry, working });
  }
  return { pending: next, retained, incoming: x, excluded };
}

export function liveChain(pending: readonly PendingEntry[]): Change[] {
  return pending.filter((entry) => entry.state !== "doomed").flatMap((entry) => [...entry.working]);
}
