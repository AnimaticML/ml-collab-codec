import type { Change } from "./change.ts";
import type { AuthoredBy } from "./builder.ts";
import { diffToChanges } from "./diff.ts";
import type { Table } from "./table.ts";
import type { ComponentNode } from "./types.ts";
import { isConflict, rebase } from "./transform.ts";

/** An unapplied proposal: the author's change expressed against the base (A) they actually read. */
export interface Proposal {
  readonly baseRevision: number;
  readonly changes: readonly Change[];
}

export type ProposalRebase =
  | { readonly status: "rebased"; readonly revision: number; readonly changes: readonly Change[] }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "contextUnavailable"; readonly reason: string };

export interface TransitionSource {
  getRevision(): number;
  transitionsSince(
    revision: number,
  ): readonly { readonly changes: readonly Change[] }[] | undefined;
}

/** proposal = diff(A, B): never diff(C, B), which would attribute others' work to the author. */
export function proposeEdit(
  base: { readonly table: Table; readonly revision: number },
  result: ComponentNode,
  author: AuthoredBy,
): Proposal {
  return { baseRevision: base.revision, changes: diffToChanges(base.table, result, author) };
}

/**
 * Rebase an unapplied proposal over accepted A→C transitions without
 * touching C. A missing base is an explicit unavailable-context result.
 * Applying the result later is an ordinary request with current checks.
 */
export function rebaseProposal(proposal: Proposal, source: TransitionSource): ProposalRebase {
  const transitions = source.transitionsSince(proposal.baseRevision);
  if (transitions === undefined)
    return {
      status: "contextUnavailable",
      reason: "the proposal's base revision is no longer retained",
    };
  let changes = proposal.changes;
  for (const transition of transitions) {
    const rebased = rebase(changes, transition.changes);
    if (isConflict(rebased)) return { status: "conflict", reason: rebased.detail };
    changes = rebased;
  }
  return { status: "rebased", revision: source.getRevision(), changes };
}
