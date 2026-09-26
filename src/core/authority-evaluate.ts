import type { Change } from "./change.ts";
import { applyChanges } from "./apply.ts";
import type { CandidateValidator } from "./invariants.ts";
import type { Ledger } from "./ledger.ts";
import type { ReceiptEvent, RequestEnvelope, TransitionEvent } from "./protocol.ts";
import { ApplyError } from "./staging.ts";
import type { Table } from "./table.ts";
import { isConflict, rebase } from "./transform.ts";
import type { Authorizer, Prepared } from "./authority-types.ts";

/** The accepted state a decision is evaluated against. */
export interface DecisionContext {
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly table: Table;
  readonly revision: number;
  readonly ledger: Ledger;
  readonly ledgerVersion: number;
  readonly validators: readonly CandidateValidator[];
  readonly authorize: Authorizer | undefined;
}

function receiptFor(
  ctx: DecisionContext,
  envelope: RequestEnvelope,
  outcome: ReceiptEvent["outcome"],
  extra: { reason?: string; committedRevision?: number },
): ReceiptEvent {
  return {
    type: "receipt",
    documentId: ctx.documentId,
    historyEpoch: ctx.historyEpoch,
    request: { replica: envelope.replica, seq: envelope.seq },
    outcome,
    evaluatedRevision: ctx.revision,
    ...extra,
  };
}

export function rejection(
  ctx: DecisionContext,
  envelope: RequestEnvelope,
  reason: string,
  actor: string,
  print: string,
): Prepared {
  return {
    ledgerVersion: ctx.ledgerVersion,
    decision: {
      kind: "decided",
      receipt: receiptFor(ctx, envelope, "rejected", { reason }),
      duplicate: false,
    },
    commit: { table: ctx.table, fingerprint: print, actor },
  };
}

/** Undo/redo links must name a group owned by the same authenticated actor. */
function relationAllowed(
  ctx: DecisionContext,
  envelope: RequestEnvelope,
  actor: string,
): string | null {
  if (envelope.meta.group !== undefined && !envelope.meta.group.startsWith(`${envelope.replica}#`))
    return "undo groups are scoped to the submitting replica";
  for (const target of [envelope.meta.undoOf, envelope.meta.redoOf]) {
    if (target === undefined) continue;
    const owner = ctx.ledger.groupOwner(target);
    if (owner === undefined) return "unknown undo group";
    if (owner !== actor) return "not authorized";
  }
  return null;
}

function candidateFor(
  ctx: DecisionContext,
  envelope: RequestEnvelope,
  history: readonly TransitionEvent[],
): { changes: readonly Change[]; candidate: Table } | string {
  let changes: readonly Change[] = envelope.changes;
  for (const transition of history) {
    const rebased = rebase(changes, transition.changes);
    if (isConflict(rebased)) return `conflict: ${rebased.conflict}`;
    changes = rebased;
  }
  try {
    return { changes, candidate: applyChanges(ctx.table, changes) };
  } catch (error) {
    if (error instanceof ApplyError) return `invalid: ${error.code}`;
    throw error;
  }
}

/**
 * Decide one new request (v3 §5.7): rebase from its submitted base over the
 * accepted transitions, apply to a private candidate, check rights against
 * the current trusted state, and check every validator on the final
 * candidate. Nothing is installed here.
 */
export function evaluateRequest(
  ctx: DecisionContext,
  envelope: RequestEnvelope,
  history: readonly TransitionEvent[],
  actor: string,
  print: string,
  trusted: boolean,
): Prepared {
  const relation = relationAllowed(ctx, envelope, actor);
  if (relation !== null) return rejection(ctx, envelope, relation, actor, print);
  const built = candidateFor(ctx, envelope, history);
  if (typeof built === "string") return rejection(ctx, envelope, built, actor, print);
  const { changes, candidate } = built;
  if (!trusted && ctx.authorize !== undefined && !ctx.authorize(actor, changes, ctx.table))
    return rejection(ctx, envelope, "not authorized", actor, print);
  for (const validator of ctx.validators) {
    const reason = validator(candidate, changes, ctx.table);
    if (reason !== null) return rejection(ctx, envelope, reason, actor, print);
  }
  const commit = { table: candidate, fingerprint: print, actor };
  if (changes.length === 0)
    return {
      ledgerVersion: ctx.ledgerVersion,
      decision: {
        kind: "decided",
        receipt: receiptFor(ctx, envelope, "alreadySatisfied", {}),
        duplicate: false,
      },
      commit,
    };
  const revision = ctx.revision + 1;
  const transition: TransitionEvent = {
    type: "transition",
    documentId: ctx.documentId,
    historyEpoch: ctx.historyEpoch,
    revision,
    request: { replica: envelope.replica, seq: envelope.seq },
    actor,
    meta: envelope.meta,
    changes,
  };
  const receipt = receiptFor(ctx, envelope, "applied", { committedRevision: revision });
  return {
    ledgerVersion: ctx.ledgerVersion,
    decision: { kind: "decided", receipt, transition, duplicate: false },
    commit,
  };
}
