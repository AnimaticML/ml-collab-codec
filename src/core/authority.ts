import type { Change } from "./change.ts";
import { applyChanges } from "./apply.ts";
import type { RequestId } from "./identity.ts";
import { Ledger } from "./ledger.ts";
import type { ReceiptEvent, RequestEnvelope, TransitionEvent } from "./protocol.ts";
import { decodeRequest, fingerprint, ProtocolError } from "./protocol.ts";
import { ApplyError } from "./staging.ts";
import type { Table } from "./table.ts";
import { isConflict, rebase } from "./transform.ts";

import type {
  AuthorityOptions,
  AuthorityState,
  Decision,
  DecisionRecord,
  Prepared,
  Principal,
} from "./authority-types.ts";
import { StaleDecisionError } from "./authority-types.ts";
export type {
  AuthorityOptions,
  AuthorityState,
  Authorizer,
  Decision,
  DecisionRecord,
  Prepared,
  Principal,
} from "./authority-types.ts";
export { recordOf, StaleDecisionError } from "./authority-types.ts";

/**
 * The one logical authority for a document/history (v3 §5.7): serializes
 * admission, rebases a request from its submitted base over accepted
 * transitions, validates rights and trusted invariants on the final
 * candidate, and atomically records the transition (if any) with its
 * terminal receipt. Earlier admitted work is never displaced.
 */
export class Authority {
  private table: Table;
  private revision: number;
  private transitions: TransitionEvent[];
  private ledger: Ledger;
  private ledgerVersion = 0;
  private readonly documentId: string;
  private readonly historyEpoch: string;

  constructor(
    state: AuthorityState,
    private readonly options: AuthorityOptions = {},
  ) {
    this.documentId = state.documentId;
    this.historyEpoch = state.historyEpoch;
    this.table = state.table;
    this.revision = state.revision;
    this.transitions = [...state.transitions];
    this.ledger = Ledger.fromExport(state.ledger);
  }

  static create(
    documentId: string,
    historyEpoch: string,
    table: Table,
    options: AuthorityOptions = {},
  ): Authority {
    const ledger = { receipts: [], replicas: [], groups: [] };
    return new Authority(
      { documentId, historyEpoch, table, revision: 0, transitions: [], ledger },
      options,
    );
  }

  scope(): { documentId: string; historyEpoch: string } {
    return { documentId: this.documentId, historyEpoch: this.historyEpoch };
  }

  getTable(): Table {
    return this.table;
  }
  getRevision(): number {
    return this.revision;
  }
  /** Lowest base revision that can still be rebased (the late-transform horizon). */
  retainedFrom(): number {
    return this.revision - this.transitions.length;
  }

  transitionsSince(revision: number): readonly TransitionEvent[] | undefined {
    if (revision < this.retainedFrom() || revision > this.revision) return undefined;
    return this.transitions.slice(revision - this.retainedFrom());
  }

  exportState(): AuthorityState {
    return {
      ...this.scope(),
      table: this.table,
      revision: this.revision,
      transitions: [...this.transitions],
      ledger: this.ledger.export(),
    };
  }

  submit(value: unknown, principal: Principal): Decision {
    return this.install(this.prepare(value, principal));
  }

  /** Admit a request whose changes a trusted application action built from current state (rights already decided). */
  submitTrusted(value: unknown, principal: Principal): Decision {
    return this.install(this.prepare(value, principal, true));
  }

  /** Record an explicit refusal (e.g. an unauthorized action) as the request's terminal receipt. */
  refuse(value: unknown, principal: Principal, reason: string): Decision {
    const envelope = decodeRequest(value);
    const found = this.ledger.lookup({ replica: envelope.replica, seq: envelope.seq });
    if (found.kind === "found")
      return { kind: "decided", receipt: found.record.receipt, duplicate: true };
    return this.install(this.reject(envelope, reason, principal.actor, fingerprint(envelope)));
  }

  prepare(value: unknown, principal: Principal, trusted = false): Prepared {
    const envelope = decodeRequest(value);
    if (envelope.documentId !== this.documentId || envelope.historyEpoch !== this.historyEpoch)
      throw new ProtocolError(
        "wrongDocument",
        "request belongs to a different document or history epoch",
      );
    const owner = this.ledger.ownerOf(envelope.replica);
    if (owner !== undefined && owner !== principal.actor)
      throw new ProtocolError(
        "notAuthorized",
        "replica is bound to a different authenticated actor",
      );
    const id = { replica: envelope.replica, seq: envelope.seq };
    const print = fingerprint(envelope);
    const found = this.ledger.lookup(id);
    const version = this.ledgerVersion;
    if (found.kind === "found") {
      if (found.record.fingerprint !== print)
        throw new ProtocolError("payloadConflict", "request id reused with different bytes");
      const transition = this.transitionFor(found.record.receipt);
      return {
        ledgerVersion: version,
        decision: {
          kind: "decided",
          receipt: found.record.receipt,
          duplicate: true,
          ...(transition ? { transition } : {}),
        },
      };
    }
    if (found.kind === "unavailable")
      return {
        ledgerVersion: version,
        decision: { kind: "resync", request: id, reason: found.reason },
      };
    if (envelope.baseRevision > this.revision)
      throw new ProtocolError("malformed", "base revision is in the future");
    const history = this.transitionsSince(envelope.baseRevision);
    if (history === undefined)
      return {
        ledgerVersion: version,
        decision: {
          kind: "resync",
          request: id,
          reason: "base revision is past the retained transform horizon",
        },
      };
    return this.evaluate(envelope, history, principal.actor, print, trusted);
  }

  private transitionFor(receipt: ReceiptEvent): TransitionEvent | undefined {
    const revision = receipt.committedRevision;
    return revision === undefined ? undefined : this.transitionsSince(revision - 1)?.[0];
  }

  private reject(
    envelope: RequestEnvelope,
    reason: string,
    actor: string,
    print: string,
  ): Prepared {
    const receipt = this.receipt(envelope, "rejected", { reason });
    return {
      ledgerVersion: this.ledgerVersion,
      decision: { kind: "decided", receipt, duplicate: false },
      commit: { table: this.table, fingerprint: print, actor },
    };
  }

  private receipt(
    envelope: RequestEnvelope,
    outcome: ReceiptEvent["outcome"],
    extra: { reason?: string; committedRevision?: number },
  ): ReceiptEvent {
    return {
      type: "receipt",
      ...this.scope(),
      request: { replica: envelope.replica, seq: envelope.seq },
      outcome,
      evaluatedRevision: this.revision,
      ...extra,
    };
  }

  private relationAllowed(envelope: RequestEnvelope, actor: string): string | null {
    if (
      envelope.meta.group !== undefined &&
      !envelope.meta.group.startsWith(`${envelope.replica}#`)
    )
      return "undo groups are scoped to the submitting replica";
    for (const target of [envelope.meta.undoOf, envelope.meta.redoOf]) {
      if (target === undefined) continue;
      const owner = this.ledger.groupOwner(target);
      if (owner === undefined) return "unknown undo group";
      if (owner !== actor) return "not authorized";
    }
    return null;
  }

  private evaluate(
    envelope: RequestEnvelope,
    history: readonly TransitionEvent[],
    actor: string,
    print: string,
    trusted: boolean,
  ): Prepared {
    const relation = this.relationAllowed(envelope, actor);
    if (relation !== null) return this.reject(envelope, relation, actor, print);
    let changes: readonly Change[] = envelope.changes;
    for (const transition of history) {
      const rebased = rebase(changes, transition.changes);
      if (isConflict(rebased))
        return this.reject(envelope, `conflict: ${rebased.conflict}`, actor, print);
      changes = rebased;
    }
    let candidate: Table;
    try {
      candidate = applyChanges(this.table, changes);
    } catch (error) {
      if (error instanceof ApplyError)
        return this.reject(envelope, `invalid: ${error.code}`, actor, print);
      throw error;
    }
    if (
      !trusted &&
      this.options.authorize !== undefined &&
      !this.options.authorize(actor, changes, this.table)
    )
      return this.reject(envelope, "not authorized", actor, print);
    for (const validator of this.options.validators ?? []) {
      const reason = validator(candidate, changes);
      if (reason !== null) return this.reject(envelope, reason, actor, print);
    }
    const commit = { table: candidate, fingerprint: print, actor };
    if (changes.length === 0) {
      const receipt = this.receipt(envelope, "alreadySatisfied", {});
      return {
        ledgerVersion: this.ledgerVersion,
        decision: { kind: "decided", receipt, duplicate: false },
        commit,
      };
    }
    const revision = this.revision + 1;
    const transition: TransitionEvent = {
      type: "transition",
      ...this.scope(),
      revision,
      request: { replica: envelope.replica, seq: envelope.seq },
      actor,
      meta: envelope.meta,
      changes,
    };
    const receipt = this.receipt(envelope, "applied", { committedRevision: revision });
    return {
      ledgerVersion: this.ledgerVersion,
      decision: { kind: "decided", receipt, transition, duplicate: false },
      commit,
    };
  }

  /** Atomically record a prepared decision (state + receipt together). */
  install(prepared: Prepared): Decision {
    if (prepared.ledgerVersion !== this.ledgerVersion)
      throw new StaleDecisionError("state changed since the decision was prepared");
    const { decision, commit } = prepared;
    if (commit === undefined || decision.kind !== "decided") return decision;
    if (decision.transition !== undefined) {
      this.transitions.push(decision.transition);
      this.revision = decision.transition.revision;
      this.table = commit.table;
    }
    this.ledger.record(
      commit.actor,
      commit.fingerprint,
      decision.receipt,
      decision.transition?.meta.group,
    );
    this.ledgerVersion += 1;
    return decision;
  }

  hasReceipt(id: RequestId): boolean {
    return this.ledger.lookup(id).kind === "found";
  }

  /** Re-install a durably logged decision on restore, without re-evaluating it. */
  replay(record: DecisionRecord): void {
    const transition = record.transition;
    if (transition !== undefined) {
      if (transition.revision !== this.revision + 1)
        throw new StaleDecisionError("tail is not contiguous with the restored state");
      this.table = applyChanges(this.table, transition.changes);
      this.transitions.push(transition);
      this.revision = transition.revision;
    }
    this.ledger.record(record.actor, record.fingerprint, record.receipt, transition?.meta.group);
    this.ledgerVersion += 1;
  }

  /** Retire transitions ≤ `revision`; late requests based before it must resync. */
  pruneTransitionsThrough(revision: number): void {
    const keep = Math.max(0, this.revision - Math.max(revision, this.retainedFrom()));
    this.transitions = this.transitions.slice(this.transitions.length - keep);
  }

  /** Retire receipts evaluated ≤ `revision`; their ids answer `resync`, never a fresh decision. */
  expireReceiptsThrough(revision: number): number {
    return this.ledger.expireThrough(revision);
  }
}
