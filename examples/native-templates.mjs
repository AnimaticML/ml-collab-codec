import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  Authority,
  CompositionIndex,
  ROOT_ID,
  canonicalJson,
  compositionComponents,
  compositionReviewKey,
  resolveCompositionPath,
  compositionValidator,
  copyCompositionFragment,
  createAllocator,
  decodeDocumentJson,
  defineDocumentSchema,
  fromTable,
  inferComposition,
  parseDocument,
  planCompositionRename,
  planSemanticAction,
  projectComposition,
  serializeDocument,
  submitSemanticPlan,
  toTable,
} from "ml-collab-codec";
import { component, join, object, submit, value } from "./lib/composition.mjs";

const string = { type: "string" };
const integer = { type: "integer" };
const profile = defineDocumentSchema({
  id: "templates-demo",
  version: "1",
  rootTag: "board",
  components: {
    ...compositionComponents,
    board: component(object({ title: string }), [
      "compositionDefinition",
      "compositionOccurrence",
      "card",
      "slot",
    ]),
    card: {
      ...component(
        object(
          {
            title: string,
            key: { ...string, "x-reference": "definition" },
          },
          ["title"],
        ),
      ),
      content: { mode: "mixed", allowedTags: ["label", "slot"] },
    },
    slot: component(
      object(
        {
          link: { ...string, "x-reference": "reference" },
        },
        [],
      ),
      ["label", "note"],
    ),
    note: { ...component(object()), content: { mode: "mixed" } },
    label: component(object({ text: string })),
  },
});
const doc = (content) => ({
  schemaId: profile.id,
  schemaVersion: profile.version,
  root: { id: "board", tag: "board", props: { title: "Native" }, content },
});
const field = (id, path, contract, extra = {}, scope = "form") => ({
  tag: "compositionField",
  id,
  props: { scope, path, ...(contract ? { contract } : {}), ...extra },
});
const definition = (id, fields, fragment = [], dependencies = {}) => ({
  tag: "compositionDefinition",
  id,
  props: { version: "1", fragment, dependencies },
  content: fields,
});
const occurrence = (id, def, values, scope = "form", extra = {}, content = []) => ({
  tag: "compositionOccurrence",
  id,
  props: { definition: def, version: "1", scope, ...(values ? { values } : {}), ...extra },
  content,
});
const item = (id, values) => ({ id, tag: "compositionItem", props: { values } });
const table = (document) =>
  toTable(value(decodeDocumentJson(document, profile)), createAllocator());
const propsOf = (row) => row.props;

function participant() {
  const fields = [
    field(
      "field-a",
      "participant.name",
      { ...string, minLength: 1 },
      { label: "Name", required: true, target: "title", property: "title" },
    ),
    field("field-b", "participant.address.city", string),
    field("field-c", "participant.name", undefined, { label: "Participant" }),
    field("field-d", "participant.email", string, { required: true }),
    field("field-e", "reviewer.name", string, { label: "Name" }),
    field("field-owner", "participant", {
      type: "object",
      properties: { name: { ...string, maxLength: 60 } },
    }),
  ];
  const fixed = [
    { tag: "card", id: "title", props: { title: "Awaiting input" }, content: ["Interview"] },
  ];
  const participantDoc = (uses) =>
    doc([
      definition("interview", uses, fixed),
      occurrence("first", "interview", { participant: { name: "Ada" } }),
    ]);
  const base = table(participantDoc(fields));
  const rebuild = table(participantDoc([...fields].reverse()));
  const definitionKey = compositionReviewKey(base, "interview");
  const model = inferComposition(base, "interview");
  assert.equal(resolveCompositionPath(model, "form", "participant.name").contract.type, "string");
  assert.throws(
    () => resolveCompositionPath(model, "form", "participant.name", "create"),
    /already exists/,
  );
  assert.equal(resolveCompositionPath(model, "elsewhere", "participant.name"), undefined);
  const state = projectComposition(base, "first")[0];
  assert.deepEqual(state.missing, ["participant.email"]);
  assert.equal(state.content[0].props.title, "Ada");
  assert.equal(state.content[0].content[0], "Interview");
  assert.deepEqual(
    state.bindings.filter((b) => b.path === "participant.name").map((b) => b.value),
    ["Ada", "Ada"],
  );
  assert.deepEqual(projectComposition(rebuild, "first")[0].values, state.values);
  assert.throws(
    () =>
      inferComposition(
        table(participantDoc([...fields, field("conflict", "participant", integer)])),
        "interview",
      ),
    /scalar\/object|incompatible/,
  );
  assert.throws(
    () =>
      inferComposition(
        table(participantDoc([...fields, field("conflict", "participant.name", integer)])),
        "interview",
      ),
    /conflict/,
  );

  const valid = compositionValidator();
  const authority = Authority.create("participant", "epoch", base, {
    schema: profile,
    validators: [valid],
  });
  const alice = join(authority, "alice");
  const before = fromTable(base, profile.id, profile.version);
  for (const roundtrip of [
    value(parseDocument(serializeDocument(before, profile), profile)),
    value(decodeDocumentJson(JSON.parse(JSON.stringify(before)), profile)),
  ])
    assert.deepEqual(projectComposition(table(roundtrip), "first")[0], state);

  alice.transact((builder) =>
    builder.set("first", ["values", "participant", "email"], "ada@example.test"),
  );
  assert.equal(submit(authority, alice).outcome, "applied");
  assert.deepEqual(projectComposition(authority.getTable(), "first")[0].missing, []);
  const full = fromTable(authority.getTable(), profile.id, profile.version);
  assert.deepEqual(value(parseDocument(serializeDocument(full, profile), profile)), full);
  assert.equal(compositionReviewKey(authority.getTable(), "interview"), definitionKey);
  alice.transact((b) =>
    b.insertNode("interview", fields.length, {
      tag: "compositionField",
      id: "phone",
      props: { scope: "form", path: "participant.phone", contract: string },
    }),
  );
  assert.equal(submit(authority, alice).outcome, "applied");
  assert.notEqual(compositionReviewKey(authority.getTable(), "interview"), definitionKey);
  assert.equal(
    resolveCompositionPath(
      inferComposition(authority.getTable(), "interview"),
      "form",
      "participant.phone",
    ).contract.type,
    "string",
  );
  const rename = planCompositionRename(
    alice.getSnapshot().table,
    "interview",
    "form",
    "participant",
    "attendee",
    { validators: [valid] },
  );
  const edit = submitSemanticPlan(alice, rename);
  assert.equal(submit(authority, alice).outcome, "applied");
  assert.equal(projectComposition(authority.getTable(), "first")[0].values.attendee.name, "Ada");
  assert.equal(alice.undo(edit.group).status, "requested");
  assert.equal(submit(authority, alice).outcome, "applied");
  assert.equal(projectComposition(authority.getTable(), "first")[0].values.participant.name, "Ada");
}

function cards() {
  const fields = [
    field(
      "card-title",
      "title",
      string,
      { required: true, target: "card-label", property: "text" },
      "item",
    ),
    field(
      "card-kind",
      "kind",
      { ...string, enum: ["task", "milestone"] },
      { required: true },
      "item",
    ),
    field(
      "points",
      "points",
      { ...integer, minimum: 0 },
      { required: true, when: { path: "kind", equals: "task" } },
      "item",
    ),
    field(
      "note-slot",
      "note",
      {
        type: "array",
        items: {
          type: "object",
          properties: { tag: { enum: ["label", "note"] } },
          required: ["tag"],
          additionalProperties: true,
        },
      },
      { target: "slot", property: "$content" },
      "item",
    ),
  ];
  const fragment = [
    {
      tag: "card",
      id: "fixed-card",
      props: { title: "", key: "card" },
      content: [
        { tag: "label", id: "card-label", props: { text: "" } },
        { tag: "slot", id: "slot", props: { link: "card" } },
      ],
    },
  ];
  const repeat = occurrence("repeat", "task-card", undefined, "item", { repeat: "work.items" }, [
    item("item-a", { title: "Prepare", kind: "task" }),
    item("item-b", {
      title: "Prepare",
      kind: "milestone",
      note: [{ tag: "note", id: "text", props: {}, content: ["Ready"] }],
    }),
  ]);
  const base = table(doc([definition("task-card", fields, fragment, { board: "1" }), repeat]));
  const options = {
    dependencies: { board: "1" },
    validateResult: (result) => {
      const checked = decodeDocumentJson(doc(result.content), profile);
      return checked.ok ? null : checked.diagnostics[0].message;
    },
  };
  const authority = Authority.create("cards", "epoch", base, {
    schema: profile,
    validators: [compositionValidator(options)],
  });
  const client = join(authority, "cards-editor");
  const index = new CompositionIndex(options);
  const first = index.project(base, "repeat");
  assert.deepEqual(first[0].missing, ["points"]);
  assert.equal(first[0].content[0].content[0].props.text, "Prepare");
  assert.equal(first[1].content[0].content[0].props.text, "Prepare");
  assert.equal(first[1].content[0].content[1].content[0].content[0], "Ready");
  assert.throws(() => projectComposition(base, "repeat"), /unavailable dependency/);
  client.transact((b) => b.moveNode("item-b", "repeat", 0));
  assert.equal(submit(authority, client).outcome, "applied");
  assert.deepEqual(
    projectComposition(authority.getTable(), "repeat", options).map((r) => r.id),
    [first[1].id, first[0].id],
  );
  const reordered = index.project(authority.getTable(), "repeat");
  assert.equal(reordered[0], first[1]);
  assert.equal(reordered[1], first[0]);
  assert.deepEqual(index.counts, { inferred: 1, evaluated: 2 });
  client.transact((b) =>
    b.insertNode("repeat", 1, {
      id: "item-c",
      tag: "compositionItem",
      props: { values: { title: "New", kind: "milestone" } },
    }),
  );
  assert.equal(submit(authority, client).outcome, "applied");
  client.transact((b) => b.deleteNode("item-c"));
  assert.equal(submit(authority, client).outcome, "applied");
  client.transact((b) => b.set("item-b", ["values", "points"], 1));
  assert.equal(submit(authority, client).outcome, "rejected");
  client.transact((b) => b.set("item-b", ["values", "note"], [{ tag: "card", props: {} }]));
  assert.equal(submit(authority, client).outcome, "rejected");
  const rename = planCompositionRename(
    client.getSnapshot().table,
    "task-card",
    "item",
    "kind",
    "category",
  );
  submitSemanticPlan(client, rename);
  assert.equal(submit(authority, client).outcome, "applied");
  assert.deepEqual(projectComposition(authority.getTable(), "repeat", options)[1].missing, [
    "points",
  ]);
  const allocate = createAllocator("copy-");
  const copied = copyCompositionFragment(
    [...fragment, { tag: "slot", id: "external-link", props: { link: "external" } }],
    profile,
    allocate,
  );
  assert.notEqual(copied[0].id, fragment[0].id);
  assert.notEqual(copied[0].props.key, "card");
  assert.equal(copied[0].content[1].props.link, copied[0].props.key);
  const current = authority.getTable();
  const saved = serializeDocument(fromTable(current, profile.id, profile.version), profile);
  const reopened = table(value(parseDocument(saved, profile)));
  assert.deepEqual(
    projectComposition(reopened, "repeat", options),
    projectComposition(current, "repeat", options),
  );
  assert.equal(copied[1].props.link, "external");
}

const scheduleSchema = defineDocumentSchema({
  id: "schedule",
  version: "1",
  rootTag: "schedule",
  components: {
    schedule: component(object(), ["entry"]),
    entry: component(
      object({ start: integer, duration: { ...integer, minimum: 1 }, label: string }),
    ),
  },
});
function scheduleTable() {
  return toTable(
    value(
      parseDocument(
        '<schedule id="schedule"><entry id="a" start="0" duration="4" label="A"/><entry id="b" start="4" duration="3" label="B"/><entry id="c" start="7" duration="2" label="C"/></schedule>',
        scheduleSchema,
      ),
    ),
    createAllocator(),
  );
}
function nonOverlap(candidate) {
  let end = 0;
  for (const id of candidate.get(ROOT_ID).children) {
    const { start, duration } = propsOf(candidate.get(id));
    if (start < end) return "overlap in stored order";
    end = start + duration;
  }
  return null;
}
function shift(base, checks = {}) {
  const order = base.get(ROOT_ID).children;
  const reads = [
    { node: ROOT_ID },
    ...order.flatMap((node) => [
      { node, property: "start" },
      { node, property: "duration" },
    ]),
  ];
  return planSemanticAction(
    base,
    "schedule.push/1",
    reads,
    { rule: "move", apply: (b) => b.set("b", "start", 6) },
    [
      {
        rule: "push-following/1",
        apply: (b) => {
          let end = 6 + base.get("b").props.duration;
          for (const id of order.slice(order.indexOf("b") + 1)) {
            const { start, duration } = base.get(id).props;
            const next = Math.max(end, start);
            b.set(id, "start", next);
            end = next + duration;
          }
        },
      },
    ],
    { validators: [nonOverlap], ...checks },
  );
}
function schedule() {
  const base = scheduleTable();
  const protect = (actor, effects) =>
    actor !== "guest" || effects.every((effect) => effect.node !== "c");
  const authority = Authority.create("schedule", "epoch", base, {
    schema: scheduleSchema,
    validators: [nonOverlap],
    authorize: protect,
  });
  const alice = join(authority, "alice");
  const bob = join(authority, "bob");
  const guest = join(authority, "guest");
  assert.throws(() => shift(base, { maxEffects: 1 }), /effect budget/);
  assert.throws(() => shift(base, { authorize: protect, actor: "guest" }), /not authorized/);
  guest.transact((b) => b.set("b", "start", 6));
  assert.equal(submit(authority, guest).reason, "overlap in stored order");
  submitSemanticPlan(guest, shift(base));
  assert.equal(submit(authority, guest).reason, "not authorized");
  assert.equal(authority.getRevision(), 0);
  const plan = shift(base);
  assert.deepEqual(
    plan.effects.map(({ requested, change }) => [requested, change.node, change.after]),
    [
      [true, "b", 6],
      [false, "c", 9],
    ],
  );
  const edit = submitSemanticPlan(alice, plan);
  const envelope = alice.nextRequest();
  const retry = canonicalJson(envelope);
  bob.transact((b) => b.set("a", "label", "Remote A"));
  assert.equal(submit(authority, bob, [alice, guest]).outcome, "applied");
  assert.equal(canonicalJson(alice.resend()), retry);
  const admitted = authority.submit(envelope, { actor: "alice" });
  assert.equal(admitted.receipt.outcome, "applied");
  assert.equal(admitted.transition.changes.length, 2);
  assert.deepEqual(admitted.transition.meta.rules, ["move", "push-following/1"]);
  assert.equal(admitted.transition.meta.guards, undefined);
  assert.equal(authority.submit(envelope, { actor: "alice" }).duplicate, true);
  for (const client of [alice, bob]) client.receive(admitted.transition);
  alice.receive(admitted.receipt);
  assert.equal(alice.undo(edit.group).status, "requested");
  assert.equal(submit(authority, alice, [bob]).outcome, "applied");
  assert.equal(authority.getTable().get("a").props.label, "Remote A");
  assert.equal(alice.redo(edit.group).status, "requested");
  assert.equal(submit(authority, alice, [bob]).outcome, "applied");
  assert.equal(alice.undo(edit.group).status, "requested");
  assert.equal(submit(authority, alice, [bob]).outcome, "applied");

  submitSemanticPlan(alice, shift(alice.getSnapshot().table));
  const stale = alice.nextRequest();
  bob.transact((b) => b.set("c", "duration", 3));
  assert.equal(submit(authority, bob, [alice]).outcome, "applied");
  const declined = authority.submit(stale, { actor: "alice" });
  assert.equal(declined.receipt.reason, "conflict: stale action reads");
  alice.receive(declined.receipt);
  assert.equal(authority.getTable().get("b").props.start, 4);
  assert.equal(authority.getTable().get("c").props.duration, 3);
}

function incremental() {
  const n = 160;
  const base = table(
    doc([
      definition("shared", [field("v", "value", string)]),
      ...Array.from({ length: n }, (_, i) =>
        occurrence(`instance-${i}`, "shared", { value: `Value ${i}` }),
      ),
    ]),
  );
  const authority = Authority.create("incremental", "epoch", base, { schema: profile });
  const client = join(authority, "editor");
  const index = new CompositionIndex();
  const scan = (snapshot) =>
    Array.from({ length: n }, (_, i) => index.project(snapshot, `instance-${i}`));
  const start = performance.now();
  const before = scan(base);
  const cold = performance.now() - start;
  client.transact((b) => b.set(ROOT_ID, "title", "Unrelated"));
  const current = client.getSnapshot().table;
  const warmStart = performance.now();
  const after = scan(current);
  const warm = performance.now() - warmStart;
  assert.deepEqual(index.counts, { inferred: 1, evaluated: n });
  assert.ok(after.every((result, i) => result === before[i]));
  client.transact((b) => b.set("instance-0", ["values", "value"], "Changed"));
  const targeted = client.getSnapshot().table;
  scan(targeted);
  assert.deepEqual(index.counts, { inferred: 1, evaluated: n + 1 });
  const rebuildStart = performance.now();
  for (let i = 0; i < n; i++) {
    assert.deepEqual(
      index.project(targeted, `instance-${i}`),
      projectComposition(targeted, `instance-${i}`),
    );
  }
  const rebuild = performance.now() - rebuildStart;
  console.log(
    JSON.stringify({
      rows: base.size,
      fanOut: n,
      coldMs: cold,
      unrelatedMs: warm,
      rebuildWithComparisonMs: rebuild,
      counts: index.counts,
    }),
  );
}

function renameOwnership() {
  const base = table(
    doc([
      definition("original", [
        field("original-name", "name", string),
        field("alternate-name", "name", string, {}, "alternate"),
        field("alternate-alias", "alias", string, {}, "alternate"),
      ]),
      definition("other", [
        field("other-name", "name", string),
        field("other-alias", "alias", string),
      ]),
      occurrence("answer", "original", { name: "Ada" }),
    ]),
  );
  for (const change of [{ definition: "other" }, { scope: "alternate" }, {}]) {
    const authority = Authority.create("rename", "epoch", base, {
      schema: profile,
      validators: [compositionValidator()],
    });
    const alice = join(authority, "alice");
    const bob = join(authority, "bob");
    const plan = planCompositionRename(
      alice.getSnapshot().table,
      "original",
      "form",
      "name",
      "alias",
    );
    submitSemanticPlan(alice, plan);
    const queued = alice.nextRequest();
    assert.ok(queued);
    const changes = Object.entries(change);
    if (changes.length > 0) {
      bob.transact((draft) => {
        for (const [key, value] of changes) draft.set("answer", key, value);
      });
      assert.equal(submit(authority, bob, [alice]).outcome, "applied");
    }
    const decision = authority.submit(queued, { actor: "alice" });
    assert.equal(decision.kind, "decided");
    const current = authority.getTable();
    if (changes.length > 0) {
      assert.equal(decision.receipt.reason, "conflict: stale action reads");
      assert.equal(decision.transition, undefined);
      assert.equal(current.get("original-name").props.path, "name");
      assert.deepEqual(current.get("answer").props.values, { name: "Ada" });
      for (const [key, value] of changes) assert.equal(current.get("answer").props[key], value);
    } else {
      assert.equal(decision.receipt.outcome, "applied");
      assert.equal(current.get("original-name").props.path, "alias");
      assert.deepEqual(current.get("answer").props.values, { alias: "Ada" });
    }
  }
}

function conditionalRequirements() {
  const detail = object({ name: string });
  const whenFull = { when: { path: "kind", equals: "full" } };
  const conditional = definition("variants", [
    field("kind", "kind", { enum: ["short", "full"] }),
    field("detail", "detail", detail, whenFull),
    field("always", "always", object({ id: string })),
  ]);
  const base = table(
    doc([
      conditional,
      occurrence("short", "variants", { kind: "short", always: { id: "x" } }),
      occurrence("full", "variants", { kind: "full", detail: {}, always: { id: "x" } }),
      occurrence("complete", "variants", { kind: "full", detail: { name: "Ada" } }),
      occurrence("excluded", "variants", { kind: "short", detail: { name: "Ada" } }),
      occurrence("filled", "variants", {
        kind: "full",
        detail: { name: "Ada" },
        always: { id: "x" },
      }),
    ]),
  );
  const validated = [];
  const options = {
    validateResult: (result) => {
      validated.push(result.owner);
      return null;
    },
  };
  assert.deepEqual(projectComposition(base, "short", options)[0].missing, []);
  assert.deepEqual(projectComposition(base, "full", options)[0].missing, ["detail.name"]);
  assert.deepEqual(projectComposition(base, "complete", options)[0].missing, ["always.id"]);
  assert.throws(
    () => projectComposition(base, "excluded", options),
    /excluded by the selected variant/,
  );
  assert.deepEqual(projectComposition(base, "filled", options)[0].missing, []);
  assert.deepEqual(validated, ["short", "filled"]);
}

function emptyRepeatScope() {
  const base = table(
    doc([
      definition("scoped", [field("name", "name", string)]),
      definition("fixed", []),
      occurrence("empty", "scoped", undefined, "form", { repeat: "rows" }),
      occurrence("fixed-empty", "fixed", undefined, "any", { repeat: "rows" }),
    ]),
  );
  const authority = Authority.create("repeat", "epoch", base, {
    schema: profile,
    validators: [compositionValidator()],
  });
  const editor = join(authority, "editor");
  assert.deepEqual(projectComposition(base, "empty"), []);
  assert.deepEqual(projectComposition(base, "fixed-empty"), []);
  editor.transact((draft) => draft.set(ROOT_ID, "title", "Validated"));
  assert.equal(submit(authority, editor).outcome, "applied");
  editor.transact((draft) => draft.set("empty", "scope", "typo"));
  const message = /empty: unknown scope "typo"/;
  assert.throws(() => projectComposition(editor.getSnapshot().table, "empty"), message);
  assert.match(submit(authority, editor).reason, message);
  assert.equal(authority.getTable().get("empty").props.scope, "form");
}

const cases = {
  participant,
  cards,
  schedule,
  incremental,
  renameOwnership,
  conditionalRequirements,
  emptyRepeatScope,
};
const selected = process.argv[2];
if (selected === undefined) for (const run of [participant, cards, schedule, incremental]) run();
else cases[selected]();
console.log("NATIVE_TEMPLATES_OK");
