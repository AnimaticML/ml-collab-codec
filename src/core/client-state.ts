import type { Change } from "./change.ts";
import { invertChanges } from "./change.ts";
import { applyChanges } from "./apply.ts";
import type { Exclusion, PendingEntry, RetainedIntent } from "./client-queue.ts";
import { liveChain, reconcile } from "./client-queue.ts";
import { requestKey } from "./identity.ts";
import { ApplyError } from "./staging.ts";
import type { Table } from "./table.ts";

/** The client's replicated state: confirmed prefix, dependent pending chain, and materialized view. */
export interface SyncState {
  readonly confirmed: Table;
  readonly revision: number;
  readonly pending: readonly PendingEntry[];
  readonly retained: readonly RetainedIntent[];
  readonly visible: Table;
}

/** A staged transition of the replicated state plus the address mapping between visible states. */
export interface Step {
  readonly state: SyncState;
  readonly mapping: readonly Change[];
  /** Which integration path produced the step (algorithm evidence, not timing). */
  readonly path?: "forward" | "recovery";
}

/**
 * Private recovery path (v3 §5.3): recompute the view as confirmed + live
 * pending forms. An entry whose form no longer applies (e.g. a move cycle
 * found only at apply time) leaves the chain like any other conflict.
 */
export function materialize(
  confirmed: Table,
  pending: readonly PendingEntry[],
  retained: readonly RetainedIntent[],
): { visible: Table; pending: readonly PendingEntry[]; retained: readonly RetainedIntent[] } {
  let chain = pending;
  let kept = retained;
  for (let guard = 0; guard <= pending.length; guard += 1) {
    let visible = confirmed;
    let failed: PendingEntry | undefined;
    for (const entry of chain) {
      if (entry.state === "doomed") continue;
      try {
        visible = applyChanges(visible, entry.working);
      } catch (error) {
        if (!(error instanceof ApplyError)) throw error;
        failed = entry;
        break;
      }
    }
    if (failed === undefined) return { visible, pending: chain, retained: kept };
    const exclusion: Exclusion =
      failed.state === "inFlight"
        ? { kind: "drop" }
        : { kind: "retain", status: "conflict", reason: "no longer applies" };
    const result = reconcile(chain, [], new Map([[requestKey(failed.id), exclusion]]));
    chain =
      failed.state === "inFlight"
        ? [{ ...failed, state: "doomed" as const }, ...result.pending]
        : result.pending;
    kept = [...kept, ...result.retained];
  }
  throw new Error("pending chain did not stabilize");
}

/** Replace the pending chain via exclusions and recompute the view, with an exact mapping between views. */
function recover(
  state: SyncState,
  confirmed: Table,
  revision: number,
  accepted: readonly Change[],
  pending: readonly PendingEntry[],
  retained: readonly RetainedIntent[],
): Step {
  const result = materialize(confirmed, pending, [...state.retained, ...retained]);
  const mapping = [
    ...invertChanges(liveChain(state.pending)),
    ...accepted,
    ...liveChain(result.pending),
  ];
  return {
    state: {
      confirmed,
      revision,
      pending: result.pending,
      retained: result.retained,
      visible: result.visible,
    },
    mapping,
    path: "recovery",
  };
}

/**
 * Move cycles are decided only against a concrete tree: two moves that are
 * individually valid can form a cycle together, which no state-free pair
 * transform can see. When both sides move nodes, integration therefore
 * takes the private recovery path, which applies every pending form.
 */
function movesOnBothSides(accepted: readonly Change[], pending: readonly PendingEntry[]): boolean {
  const moves = (changes: readonly Change[]): boolean =>
    changes.some((change) => change.kind === "nodeMove");
  return (
    moves(accepted) && pending.some((entry) => entry.state !== "doomed" && moves(entry.working))
  );
}

/** Forward path for a compatible accepted transition, falling back to private recovery. */
export function integrate(
  state: SyncState,
  accepted: readonly Change[],
  revision: number,
  pending: readonly PendingEntry[],
): Step {
  const confirmed = applyChanges(state.confirmed, accepted);
  const result = reconcile(pending, accepted);
  if (!result.excluded && !movesOnBothSides(accepted, pending)) {
    try {
      const visible = applyChanges(state.visible, result.incoming);
      return {
        state: { ...state, confirmed, revision, pending: result.pending, visible },
        mapping: result.incoming,
        path: "forward",
      };
    } catch (error) {
      if (!(error instanceof ApplyError)) throw error;
    }
  }
  return recover(state, confirmed, revision, accepted, result.pending, result.retained);
}

/** Remove entries (receipt outcomes, cancellation) and rebase the rest over their exclusion. */
export function exclude(state: SyncState, exclusions: ReadonlyMap<string, Exclusion>): Step {
  const doomed = state.pending.filter(
    (entry) => entry.state === "doomed" && exclusions.has(requestKey(entry.id)),
  );
  const retainedDoomed: RetainedIntent[] = doomed.flatMap((entry) => {
    const how = exclusions.get(requestKey(entry.id));
    return how?.kind === "retain"
      ? [
          {
            id: entry.id,
            meta: entry.meta,
            working: entry.working,
            status: how.status,
            reason: how.reason,
          },
        ]
      : [];
  });
  const remaining = state.pending.filter((entry) => !doomed.includes(entry));
  const result = reconcile(remaining, [], exclusions);
  if (!result.excluded) {
    return {
      state: {
        ...state,
        pending: result.pending,
        retained: [...state.retained, ...retainedDoomed],
      },
      mapping: [],
    };
  }
  return recover(
    { ...state, pending: state.pending },
    state.confirmed,
    state.revision,
    [],
    result.pending,
    [...retainedDoomed, ...result.retained],
  );
}
