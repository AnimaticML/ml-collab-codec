import type { Change } from "./change.ts";
import type { RequestId } from "./identity.ts";
import type { CandidateValidator } from "./invariants.ts";
import type { LedgerExport } from "./ledger.ts";
import type { ReceiptEvent, TransitionEvent } from "./protocol.ts";
import type { Table } from "./table.ts";

export interface Principal {
  /** Authenticated actor supplied by the host adapter; never taken from the request body. */
  readonly actor: string;
}

/** Host-supplied rights check against the current trusted state, atomically with commit. */
export type Authorizer = (actor: string, changes: readonly Change[], current: Table) => boolean;

export interface AuthorityState {
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly table: Table;
  readonly revision: number;
  /** Retained effective transitions, contiguous, ending at `revision`. */
  readonly transitions: readonly TransitionEvent[];
  readonly ledger: LedgerExport;
}

export interface AuthorityOptions {
  readonly validators?: readonly CandidateValidator[];
  readonly authorize?: Authorizer;
}

export type Decision =
  | {
      readonly kind: "decided";
      readonly receipt: ReceiptEvent;
      readonly transition?: TransitionEvent;
      readonly duplicate: boolean;
    }
  | { readonly kind: "resync"; readonly request: RequestId; readonly reason: string };

/** A decision prepared against one ledger version; installing it on a newer state is refused. */
export interface Prepared {
  readonly decision: Decision;
  readonly ledgerVersion: number;
  readonly commit?: { readonly table: Table; readonly fingerprint: string; readonly actor: string };
}

export class StaleDecisionError extends Error {}

/** One durably logged admission: the terminal receipt, the request's canonical bytes, and the transition if effectful. */
export interface DecisionRecord {
  readonly actor: string;
  readonly fingerprint: string;
  readonly receipt: ReceiptEvent;
  readonly transition?: TransitionEvent;
}

/** The durable record a prepared decision would write, or undefined when nothing new is recorded. */
export function recordOf(prepared: Prepared): DecisionRecord | undefined {
  const { decision, commit } = prepared;
  if (commit === undefined || decision.kind !== "decided") return undefined;
  return {
    actor: commit.actor,
    fingerprint: commit.fingerprint,
    receipt: decision.receipt,
    ...(decision.transition === undefined ? {} : { transition: decision.transition }),
  };
}
