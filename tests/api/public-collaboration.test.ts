// Exercises the operation/collaboration/history/runtime part of the public API
// through src/index.ts only, as an application would use it.
import { expect, test } from "bun:test";
import {
  anchoredContent,
  applyChanges,
  ApplyError,
  Authority,
  AuthorityHost,
  canonicalJson,
  CHECKPOINT_FORMAT,
  CHANGE_KINDS,
  ChangeBuilder,
  CheckpointError,
  children,
  ClassProjection,
  Client,
  compareOrigin,
  compose,
  conservativeCoalescing,
  CONTROL_PROFILE,
  createAllocator,
  createSelector,
  DecodeError,
  decodeChanges,
  decodeRequest,
  DependencyCycleError,
  DerivedGraph,
  diffToChanges,
  exportCheckpoint,
  findOccurrence,
  fingerprint,
  fromTable,
  IdentityError,
  importCheckpoint,
  invertChange,
  invertChanges,
  isConflict,
  isReplicaId,
  mapAnchor,
  mapAnchorFrom,
  MAX_SEQUENCE,
  mergeContainers,
  noCoalescing,
  OPERATION_FORMAT,
  proposeEdit,
  ProtocolError,
  rebase,
  rebaseProposal,
  recordOf,
  requestKey,
  restoreAuthority,
  ROOT_ID,
  schemaValidator,
  SequenceAllocator,
  splitContainer,
  StaleDecisionError,
  StaleOwnerError,
  TEXT_TAG,
  textHunks,
  textOf,
  toTable,
  TransformLimitError,
  transformPair,
  typingHistoryPolicy,
  unwrap,
  wrapText,
  registerSchema,
} from "../../src/index.ts";
import type {
  AllocatorState,
  AllocatorStore,
  Anchor,
  AnchorResult,
  ApplyErrorCode,
  AsyncState,
  AuthoredBy,
  AuthorityOptions,
  AuthorityState,
  Authorizer,
  CandidateValidator,
  Change,
  ChangeKind,
  ChangeSummary,
  CheckpointBundle,
  ClientOptions,
  ClientSession,
  ClientStatus,
  CoalescingPolicy,
  CommitCause,
  Decision,
  DecisionRecord,
  DerivationContext,
  DocumentSnapshot,
  DocumentStore,
  DurableStore,
  EditShape,
  GroupingContext,
  GroupRecord,
  Handle,
  HistoryExport,
  HistoryPolicy,
  ModelCommit,
  NodeSpec,
  OccurrenceLookup,
  Origin,
  Outcome,
  PendingEntry,
  Prepared,
  Principal,
  ProjectedInstance,
  ProjectionOptions,
  PropPath,
  Proposal,
  ProposalRebase,
  ProtocolErrorCode,
  ReceiptEvent,
  RequestEnvelope,
  RequestId,
  RequestMeta,
  RetainedIntent,
  RetainedStatus,
  Scheduler,
  Selector,
  ServerEvent,
  StatusEvent,
  StoredHistory,
  SubtreeRecord,
  Table,
  TableNode,
  TextHunk,
  TextSegment,
  TransactResult,
  TransformConflict,
  TransformConflictCode,
  Transformed,
  TransitionEvent,
  TransitionSource,
  UndoResult,
  UnsentCoalescingContext,
} from "../../src/index.ts";

const schema = registerSchema({
  id: "api.collab",
  version: "1.0.0",
  rootTag: "doc",
  unknownPolicy: "error",
  components: {
    doc: {
      tag: "doc",
      identity: "none",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        n: { type: "number", additive: true },
      },
      content: { mode: "mixed", allowedTags: ["p", "em"] },
    },
    p: {
      tag: "p",
      identity: "stable",
      properties: {},
      content: { mode: "mixed", allowedTags: ["em"] },
    },
    em: { tag: "em", identity: "none", properties: {}, content: { mode: "mixed" } },
  },
});

function base(): Table {
  return toTable(
    {
      schemaId: schema.id,
      schemaVersion: schema.version,
      root: {
        tag: "doc",
        props: { tags: ["a", "a"], n: 1 },
        content: [
          { tag: "p", id: "p1", props: {}, content: ["hello world"] },
          { tag: "p", id: "p2", props: {}, content: ["tail"] },
        ],
      },
    },
    createAllocator(),
  );
}

test("public API: records, builders, transforms, and composition", () => {
  const table = base();
  const run = table.get("p1")?.children[0] ?? "";
  const author: AuthoredBy = { replica: "replica-a", seq: 1 };
  const builder = new ChangeBuilder(table, author);
  const spec: NodeSpec = { tag: "em", children: ["!"] };
  builder.insertNode("p2", 1, spec);
  const created = splitContainer(builder, "p1", run, 5, { tag: "p", id: "p3" });
  mergeContainers(builder, "p1", created);
  const wrapper = wrapText(builder, run, 0, 5, { tag: "em" });
  unwrap(builder, wrapper);
  const changes: readonly Change[] = builder.changes;
  const kinds = new Set<ChangeKind>(changes.map((c) => c.kind));
  expect(kinds.has("nodeMove")).toBe(true);
  const after = applyChanges(table, changes);
  const print = (t: Table) =>
    JSON.stringify(fromTable(t, schema.id, schema.version).root.content?.[0]);
  expect(print(after)).toBe(print(table));
  expect(
    applyChanges(after, invertChanges(decodeChanges(JSON.parse(JSON.stringify(changes))))).get(
      "p2",
    ),
  ).toEqual(table.get("p2"));
  expect(textOf(table.get(run))).toBe("hello world");
  const first = changes[0] as Change;
  expect(invertChange(invertChange(first))).toEqual(first);
  const origin: Origin = first.origin;
  expect(compareOrigin(origin, { ...origin, ordinal: origin.ordinal + 1 })).toBeLessThan(0);
  const subtree: SubtreeRecord | undefined =
    first.kind === "nodeInsert" ? first.subtree : undefined;
  expect(subtree?.tag).toBe("em");
  const path: PropPath = ["tags"];
  const found: OccurrenceLookup = findOccurrence(table, ROOT_ID, path, "a");
  expect(found.status).toBe("ambiguous");
  expect(children(after, ROOT_ID).map((row: TableNode) => row.id)).toEqual(["p1", "p2"]);
  expect(TEXT_TAG).toBe("#text");
  const ins = new ChangeBuilder(table, { replica: "replica-b", seq: 1 }).textInsert(
    run,
    5,
    ",",
  ).changes;
  const paired: Transformed | TransformConflict = transformPair(ins, changes);
  expect(isConflict(paired)).toBe(false);
  const rebased = rebase(ins, changes);
  expect(isConflict(rebased)).toBe(false);
  const conflict: TransformConflict = { conflict: "concurrentWrite", detail: "x" };
  const code: TransformConflictCode = conflict.conflict;
  expect(isConflict(conflict) && code).toBe("concurrentWrite");
  expect(compose(ins, [])).toEqual([...ins]);
  const hunks: readonly TextHunk[] = textHunks("abc def ghi", "aXc def ghY");
  expect(hunks).toEqual([
    { from: 1, to: 2, insert: "X" },
    { from: 10, to: 11, insert: "Y" },
  ]);
  expect(
    diffToChanges(table, fromTable(after, schema.id, schema.version).root, author).length,
  ).toBeGreaterThan(0);
  const failure = (() => {
    try {
      applyChanges(table, [{ ...(ins[0] as Change), node: "missing" } as Change]);
      return undefined;
    } catch (error) {
      return error instanceof ApplyError ? error.code : undefined;
    }
  })();
  const applyCode: ApplyErrorCode | undefined = failure;
  expect(applyCode).toBe("missingNode");
  expect(() => decodeChanges([{ kind: "nope" }])).toThrow(DecodeError);
  expect(new TransformLimitError("x")).toBeInstanceOf(Error);
  expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(OPERATION_FORMAT).toBe("sdl.ops/2");
  expect(CHANGE_KINDS).toContain("setTag");
});

test("public API: identity, protocol, authority, host, and checkpoints", () => {
  const saved: AllocatorState[] = [];
  const store: AllocatorStore = { load: () => saved.at(-1), save: (s) => void saved.push(s) };
  const allocator = SequenceAllocator.open(store, () => "replica-api");
  expect(isReplicaId(allocator.replica) && allocator.next()).toBe(1);
  expect(() => SequenceAllocator.ephemeral("x", MAX_SEQUENCE).next()).toThrow(IdentityError);
  const table = base();
  const validators: CandidateValidator[] = [schemaValidator(schema)];
  const authorize: Authorizer = (actor) => actor !== "blocked";
  const options: AuthorityOptions = { validators, authorize };
  const auth = Authority.create("doc", "epoch", table, options);
  const changes = new ChangeBuilder(table, { replica: allocator.replica, seq: 1 }).delta(
    ROOT_ID,
    "n",
    2,
  ).changes;
  const meta: RequestMeta = { authoredRevision: 0 };
  const request: RequestEnvelope = decodeRequest({
    profile: CONTROL_PROFILE,
    opFormat: OPERATION_FORMAT,
    documentId: "doc",
    historyEpoch: "epoch",
    replica: allocator.replica,
    seq: 1,
    baseRevision: 0,
    changes,
    meta,
  });
  expect(fingerprint(request)).toBe(canonicalJson(request));
  const principal: Principal = { actor: "api" };
  const prepared: Prepared = auth.prepare(request, principal);
  const record: DecisionRecord | undefined = recordOf(prepared);
  const decision: Decision = auth.install(prepared);
  expect(() => auth.install(prepared)).toThrow(StaleDecisionError);
  const events: ServerEvent[] =
    decision.kind === "decided" && decision.transition !== undefined
      ? [decision.transition, decision.receipt]
      : [];
  const transition = events[0] as TransitionEvent;
  const receipt = events[1] as ReceiptEvent;
  const outcome: Outcome = receipt.outcome;
  expect([outcome, transition.revision, record?.receipt.outcome]).toEqual([
    "applied",
    1,
    "applied",
  ]);
  const id: RequestId = receipt.request;
  expect(requestKey(id)).toBe("replica-api#1");
  const errorCode: ProtocolErrorCode = "wrongDocument";
  expect(() => auth.submit({ ...request, documentId: "other" }, principal)).toThrow(ProtocolError);
  expect(new ProtocolError(errorCode, "x").code).toBe("wrongDocument");
  const state: AuthorityState = auth.exportState();
  const bundle: CheckpointBundle = exportCheckpoint(auth, {
    id: schema.id,
    version: schema.version,
  });
  expect(bundle.format).toBe(CHECKPOINT_FORMAT);
  expect(importCheckpoint(bundle, { id: schema.id, version: schema.version }).revision).toBe(
    state.revision,
  );
  expect(() =>
    importCheckpoint({ ...bundle, format: "x" }, { id: schema.id, version: schema.version }),
  ).toThrow(CheckpointError);
  expect(
    restoreAuthority(bundle, [], { id: schema.id, version: schema.version }).getRevision(),
  ).toBe(1);
  const records: DecisionRecord[] = [];
  let published: CheckpointBundle | undefined;
  let owner = 0;
  const durable: DurableStore = {
    read: (): StoredHistory => ({ checkpoint: published, records, position: records.length }),
    append: (expected, who, r) =>
      who !== owner
        ? "fenced"
        : expected !== records.length
          ? "stale"
          : (records.push(r), "committed"),
    acquire: () => ++owner,
    stageCheckpoint: (b) => ((published = b), "cp"),
    publishCheckpoint: () => undefined,
    pruneThrough: () => undefined,
  };
  const host = AuthorityHost.open(durable, { id: schema.id, version: schema.version }, () =>
    Authority.create("doc", "epoch", table, options),
  );
  AuthorityHost.open(durable, { id: schema.id, version: schema.version }, () =>
    Authority.create("doc", "epoch", table, options),
  );
  expect(() => host.submit(request, principal)).toThrow(StaleOwnerError);
});

test("public API: client store, history, anchors, proposals, and runtime adapters", () => {
  const table = base();
  const run = table.get("p1")?.children[0] ?? "";
  let now = 0;
  const policy: HistoryPolicy = typingHistoryPolicy(500);
  const coalescing: CoalescingPolicy = {
    allow: (ctx: UnsentCoalescingContext) =>
      conservativeCoalescing.allow(ctx) && !noCoalescing.allow(ctx),
  };
  const options: ClientOptions = {
    documentId: "doc",
    historyEpoch: "epoch",
    allocator: SequenceAllocator.ephemeral("replica-c"),
    actor: "c",
    table,
    revision: 0,
    now: () => now,
    historyPolicy: policy,
    coalescing,
  };
  const client = new Client(options);
  const store: DocumentStore = client;
  const commits: ModelCommit[] = [];
  store.subscribeCommits((commit) => commits.push(commit));
  const statuses: StatusEvent[] = [];
  client.subscribeStatus((status) => statuses.push(status));
  client.subscribeErrors(() => undefined);
  const result: TransactResult = client.transact((b) => b.textInsert(run, 0, ">"));
  now = 100;
  client.transact((b) => b.textInsert(run, 1, ">"));
  const snapshot: DocumentSnapshot = store.getSnapshot();
  const cause: CommitCause | undefined = commits[0]?.cause;
  const summary: ChangeSummary | undefined = commits[0]?.changes;
  expect([result.status, cause, summary?.text, snapshot.contentRevision]).toEqual([
    "applied",
    "local",
    [run],
    2,
  ]);
  const status: ClientStatus = client.getStatus();
  const pending: readonly PendingEntry[] = client.state.pending;
  const shape: EditShape = pending[0]?.shape ?? { kind: "other", target: "", start: 0, end: 0 };
  expect([status.unsent.length, shape.kind]).toEqual([1, "insertText"]);
  const grouping: GroupingContext = {
    actor: "c",
    session: "s",
    explicitToken: undefined,
    previous: undefined,
    current: shape,
    now: 0,
    remoteSincePrevious: false,
    closed: false,
  };
  expect(policy.group(grouping)).toBe("start-new");
  const group: GroupRecord | undefined = client.history.latestUndoable();
  const handle: Handle | undefined = group?.undo;
  const history: HistoryExport = client.history.export();
  expect([handle !== undefined, history.groups.length]).toEqual([true, 1]);
  const undo: UndoResult = client.undo();
  expect(undo.status).toBe("cancelledLocally");
  const session: ClientSession = client.exportSession();
  const retained: readonly RetainedIntent[] = session.retained;
  const retainedStatus: RetainedStatus = "rejected";
  expect([retained.length, retainedStatus]).toEqual([0, "rejected"]);
  const caret: Anchor = { kind: "point", node: run, offset: 0, affinity: "after" };
  const segment: TextSegment = { node: run, from: 0, to: 5 };
  const mapped: AnchorResult = mapAnchor({ kind: "range", segments: [segment] }, []);
  expect([mapped.status, anchoredContent(table, caret)]).toEqual(["mapped", ""]);
  const auth = Authority.create("doc", "epoch", table);
  const source: TransitionSource = auth;
  expect(mapAnchorFrom(caret, 0, source).status).toBe("mapped");
  const proposal: Proposal = proposeEdit(
    { table, revision: 0 },
    fromTable(table, schema.id, schema.version).root,
    { replica: "replica-p", seq: 1 },
  );
  const rebased: ProposalRebase = rebaseProposal(proposal, source);
  expect(rebased.status).toBe("rebased");
  const scheduler: Scheduler = { schedule: () => () => undefined };
  const graph = new DerivedGraph(client.getSnapshot().table, scheduler);
  graph.define("text", (ctx: DerivationContext) => ctx.text(run));
  graph.defineAsync<number>("async", (_ctx, done) => done(1));
  const async: AsyncState<number> = graph.read("async");
  graph.define("loop", (ctx) => ctx.derived("loop"));
  expect([graph.read("text"), async.status]).toEqual(["hello world", "ready"]);
  expect(() => graph.read("loop")).toThrow(DependencyCycleError);
  const instance: ProjectedInstance = { install: () => undefined };
  const projectionOptions: ProjectionOptions<ProjectedInstance> = {
    accepts: (row) => row.tag === "p",
    create: () => instance,
    graph,
  };
  expect(new ClassProjection(client, projectionOptions).ids().sort()).toEqual(["p1", "p2"]);
  const selector: Selector<number> = createSelector(
    client,
    (s) => [s.contentRevision] as const,
    (revision) => revision,
  );
  expect(selector.get()).toBe(client.getSnapshot().contentRevision);
});
