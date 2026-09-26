import { ChangeBuilder } from "./builder.ts";
import { AuthoringState, envelopeFor } from "./client-authoring.ts";
import type { Exclusion, PendingEntry } from "./client-queue.ts";
import type { Step, SyncState } from "./client-state.ts";
import { exclude, materialize } from "./client-state.ts";
import { classify } from "./grouping.ts";
import { UndoHistory } from "./history.ts";
import type { RequestId } from "./identity.ts";
import type { Table } from "./table.ts";
import { requestKey, sameRequest } from "./identity.ts";
import type { RequestEnvelope, RequestMeta, ServerEvent } from "./protocol.ts";
import { ProtocolError } from "./protocol.ts";
import type {
  CommitCause,
  DocumentSnapshot,
  DocumentStore,
  ModelCommit,
  StatusEvent,
} from "./store.ts";
import { Publisher } from "./store.ts";
import { runRedo, runUndo } from "./client-undo.ts";
import { Inbox } from "./client-inbox.ts";
import type { ClientOptions, ClientSession, ClientStatus, TransactResult } from "./client-types.ts";
export type { ClientOptions, ClientSession, ClientStatus, TransactResult } from "./client-types.ts";
import type { UndoResult } from "./client-undo.ts";

/**
 * An optimistic replica of one document (v3 §5.3): one in-flight request
 * plus an ordered dependent unsent queue, forward paired rebasing of
 * incoming transitions, private recovery after rejection or conflict, and
 * one coherent publication per public call.
 */
export class Client implements DocumentStore {
  state: SyncState;
  readonly history: UndoHistory;
  readonly publisher: Publisher;
  private readonly inbox = new Inbox();
  private readonly integrations = { forward: 0, recovery: 0 };
  private readonly authoring: AuthoringState;
  private deferredUndo: string | undefined;
  private readonly now: () => number;

  constructor(readonly options: ClientOptions) {
    const restored = options.restore;
    if (
      restored !== undefined &&
      (restored.documentId !== options.documentId ||
        restored.historyEpoch !== options.historyEpoch ||
        restored.revision !== options.revision)
    )
      throw new ProtocolError(
        "wrongDocument",
        "session belongs to a different document, epoch, or revision",
      );
    const view = materialize(options.table, restored?.pending ?? [], restored?.retained ?? []);
    this.state = {
      confirmed: options.table,
      revision: options.revision,
      pending: view.pending,
      retained: view.retained,
      visible: view.visible,
    };
    this.history =
      restored === undefined
        ? new UndoHistory(options.revision, options.undoLimit)
        : UndoHistory.restore(restored.history, options.undoLimit);
    this.now = options.now ?? (() => 0);
    this.authoring = new AuthoringState(
      { actor: options.actor, session: options.session ?? options.allocator.replica },
      options.historyPolicy,
      options.coalescing,
    );
    this.publisher = new Publisher({
      table: this.state.visible,
      contentRevision: 0,
      documentId: options.documentId,
      historyEpoch: options.historyEpoch,
      basis: this.basis(),
    });
  }

  get replica(): string {
    return this.options.allocator.replica;
  }

  getSnapshot(): DocumentSnapshot {
    return this.publisher.getSnapshot();
  }
  subscribeCommits(listener: (commit: ModelCommit) => void): () => void {
    return this.publisher.subscribeCommits(listener);
  }
  subscribeStatus(listener: (status: StatusEvent) => void): () => void {
    return this.publisher.subscribeStatus(listener);
  }
  subscribeErrors(listener: (error: unknown) => void): () => void {
    return this.publisher.subscribeErrors(listener);
  }

  private basis(): DocumentSnapshot["basis"] {
    return {
      confirmedRevision: this.state.revision,
      pending: this.state.pending.map((entry) => entry.id),
    };
  }

  /** Apply a staged step to the private state and the current publication batch. */
  commitStep(step: Step, cause?: CommitCause, notes: readonly string[] = []): void {
    if (step.path !== undefined) this.integrations[step.path] += 1;
    this.state = step.state;
    this.publisher.stage(step.state.visible, step.mapping, cause);
    this.publisher.stageStatus(
      { confirmedRevision: this.state.revision, pending: this.basis().pending, notes },
      this.basis(),
    );
  }

  getStatus(): ClientStatus {
    const pending = this.state.pending;
    return {
      confirmedRevision: this.state.revision,
      inFlight: pending.find((entry) => entry.state !== "unsent")?.id,
      unsent: pending.filter((entry) => entry.state === "unsent").map((entry) => entry.id),
      doomed: pending.filter((entry) => entry.state === "doomed").map((entry) => entry.id),
      retained: this.state.retained,
      integrations: { ...this.integrations },
    };
  }

  /** Begin an explicit gesture/agent-task group that spans remote activity and several requests. */
  beginGroup(label: string): void {
    this.authoring.begin(`${this.replica}:${label}:${this.now()}`, label);
  }
  endGroup(): void {
    this.authoring.end();
  }
  /** Explicitly close the current automatic group (e.g. cursor moved). */
  closeGroup(): void {
    this.authoring.close();
  }

  /** Author one local change against the visible state. Never waits for the network. */
  transact(build: (builder: ChangeBuilder) => void): TransactResult {
    if (this.publisher.isDelivering()) {
      this.publisher.defer(() => void this.transact(build));
      return { status: "queued" };
    }
    return this.publisher.batch("local", () => this.author(build, {}, "local"));
  }

  /** Shared authoring path for local edits and undo/redo requests. */
  author(
    build: (builder: ChangeBuilder) => void,
    meta: RequestMeta,
    cause: CommitCause,
  ): TransactResult {
    const seq = this.options.allocator.next();
    const builder = new ChangeBuilder(this.state.visible, { replica: this.replica, seq });
    build(builder);
    if (builder.changes.length === 0) return { status: "empty" };
    const changes = [...builder.changes];
    const shape = classify(changes);
    const at = this.now();
    const isHistoryAction = meta.undoOf !== undefined || meta.redoOf !== undefined;
    const group = isHistoryAction
      ? undefined
      : this.authoring.chooseGroup(
          `${this.replica}#${seq}`,
          shape,
          at,
          (id: string) => this.history.get(id) !== undefined,
        );
    const fullMeta: RequestMeta = {
      ...meta,
      ...(group === undefined ? {} : { group }),
      authoredRevision: this.state.revision,
      predecessors: this.state.pending.map((entry) => entry.id.seq),
      authoredAt: at,
    };
    const packed =
      group === undefined
        ? undefined
        : this.authoring.pack(this.state.pending, changes, shape, group, seq);
    const pending = packed ?? [
      ...this.state.pending,
      {
        id: { replica: this.replica, seq },
        meta: fullMeta,
        working: changes,
        shape,
        state: "unsent" as const,
      },
    ];
    if (!isHistoryAction && group !== undefined) {
      this.history.clearRedo();
      this.history.addMember(group, seq, this.authoring.label);
      this.authoring.noteAuthored(group, shape, at);
    }
    this.commitStep(
      { state: { ...this.state, pending, visible: builder.current() }, mapping: changes },
      cause,
    );
    const request = { replica: this.replica, seq };
    const into = packed === undefined ? undefined : packed[packed.length - 1]?.id;
    return {
      status: "applied",
      request,
      group: group ?? meta.undoOf ?? meta.redoOf ?? "",
      ...(into === undefined ? {} : { packedInto: into }),
    };
  }

  /** The next request to send, if nothing is in flight. Its bytes are frozen from now on. */
  nextRequest(): RequestEnvelope | undefined {
    const first = this.state.pending[0];
    if (first === undefined || first.state !== "unsent") return undefined;
    const envelope = envelopeFor(this.options, first, this.state.revision);
    const sent: PendingEntry = { ...first, state: "inFlight", submitted: envelope };
    this.state = { ...this.state, pending: [sent, ...this.state.pending.slice(1)] };
    return envelope;
  }

  /** Retry of the in-flight request: the identical original envelope, even after local rebasing. */
  resend(): RequestEnvelope | undefined {
    return this.state.pending.find((entry) => entry.submitted !== undefined)?.submitted;
  }

  receive(events: ServerEvent | readonly ServerEvent[]): void {
    const list = Array.isArray(events)
      ? (events as readonly ServerEvent[])
      : [events as ServerEvent];
    for (const event of list)
      if (
        event.documentId !== this.options.documentId ||
        event.historyEpoch !== this.options.historyEpoch
      )
        throw new ProtocolError(
          "wrongDocument",
          "event belongs to a different document or history epoch",
        );
    if (this.publisher.isDelivering()) {
      this.publisher.defer(() => this.receive(list));
      return;
    }
    this.publisher.batch("remote", () => {
      this.inbox.accept(list, this.state.revision);
      this.inbox.drain(this);
      const deferred = this.deferredUndo;
      if (
        deferred !== undefined &&
        !this.state.pending.some(
          (entry) => entry.meta.group === deferred && entry.state !== "unsent",
        )
      ) {
        this.deferredUndo = undefined;
        runUndo(this, deferred);
      }
    });
  }

  /**
   * Explicit recovery when the authority reports that this replica's
   * context is past its retained history (v3 §5.7/§8.4): adopt a fresh
   * authoritative snapshot, keep every pending request as retained intent
   * (status `resync`) for review or a new attempt, and drop history handles
   * whose context no longer exists. Nothing is guessed or replayed.
   */
  resync(table: Table, revision: number, reason: string): void {
    this.publisher.batch("restore", () => {
      const retained = this.state.pending.map((entry) => ({
        id: entry.id,
        meta: entry.meta,
        working: entry.working,
        status: "resync" as const,
        reason,
      }));
      this.history.forgetAll(revision);
      this.inbox.clear();
      const state = {
        confirmed: table,
        revision,
        pending: [],
        retained: [...this.state.retained, ...retained],
        visible: table,
      };
      this.commitStep({ state, mapping: [] }, "restore", [`resync: ${reason}`]);
      this.publisher.stageRestore(table);
    });
  }

  /** Cancel a genuinely unsent local request; dependents that cannot survive are retained as blocked. */
  cancel(request: RequestId): boolean {
    const entry = this.state.pending.find((candidate) => sameRequest(candidate.id, request));
    if (entry === undefined || entry.state !== "unsent") return false;
    this.publisher.batch("reconcile", () =>
      this.commitStep(
        exclude(this.state, new Map<string, Exclusion>([[requestKey(request), { kind: "drop" }]])),
      ),
    );
    return true;
  }

  undo(group?: string): UndoResult {
    return this.publisher.batch("undo", () => runUndo(this, group));
  }

  redo(group?: string): UndoResult {
    return this.publisher.batch("redo", () => runRedo(this, group));
  }

  /** A remote document change was integrated (closes automatic typing groups). */
  noteRemote(): void {
    this.authoring.noteRemote();
  }

  deferUndo(group: string): void {
    this.deferredUndo = group;
  }

  exportSession(): ClientSession {
    const { documentId, historyEpoch } = this.options;
    return JSON.parse(
      JSON.stringify({
        format: "sdl.client-session/1",
        documentId,
        historyEpoch,
        revision: this.state.revision,
        pending: this.state.pending,
        retained: this.state.retained,
        history: this.history.export(),
      }),
    ) as ClientSession;
  }
}
