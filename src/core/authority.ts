import { applyChanges } from "./apply.ts";
import type { RequestId } from "./identity.ts";
import { Ledger } from "./ledger.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { CandidateValidator } from "./invariants.ts";
import { schemaValidator } from "./invariants.ts";
import { validateTable } from "./validate.ts";
import type { ReceiptEvent, TransitionEvent } from "./protocol.ts";
import type { DecisionContext } from "./authority-evaluate.ts";
import { evaluateRequest, rejection } from "./authority-evaluate.ts";
import { decodeRequest, fingerprint, ProtocolError } from "./protocol.ts";
import type { Table } from "./table.ts";

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

  private readonly validators: readonly CandidateValidator[];
  private readonly listeners = new Set<(transition: TransitionEvent) => void>();

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
    const schema = options.schema;
    if (schema !== undefined) {
      const issues = validateTable(state.table, schema);
      if (issues.length > 0) throw new DiagnosticError(issues);
    }
    this.validators = [
      ...(schema === undefined ? [] : [schemaValidator(schema)]),
      ...(options.validators ?? []),
    ];
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
    return this.install(
      rejection(this.context(), envelope, reason, principal.actor, fingerprint(envelope)),
    );
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
    return evaluateRequest(this.context(), envelope, history, principal.actor, print, trusted);
  }

  private transitionFor(receipt: ReceiptEvent): TransitionEvent | undefined {
    const revision = receipt.committedRevision;
    return revision === undefined ? undefined : this.transitionsSince(revision - 1)?.[0];
  }

  private context(): DecisionContext {
    return {
      ...this.scope(),
      table: this.table,
      revision: this.revision,
      ledger: this.ledger,
      ledgerVersion: this.ledgerVersion,
      validators: this.validators,
      authorize: this.options.authorize,
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
    if (decision.transition !== undefined) this.announce(decision.transition);
    return decision;
  }

  /**
   * Observe every accepted transition as it is installed (in revision order).
   * A join fence subscribes before capturing its snapshot, so no transition
   * between capture and live delivery can be missed.
   */
  subscribe(listener: (transition: TransitionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(transition: TransitionEvent): void {
    for (const listener of [...this.listeners]) listener(transition);
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
    if (transition !== undefined) this.announce(transition);
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
