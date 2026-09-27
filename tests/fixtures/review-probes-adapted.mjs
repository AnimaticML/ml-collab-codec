/**
 * ADAPTED COPY of review-evidence/ml-collab-codec-review-probes.mjs (which stays byte-for-byte
 * unchanged). Changes, per review-evidence/README.md:
 * - V4: `schemaInvariants` was renamed `schemaValidator` (and `Authority` accepts `{ schema }`).
 * - I1/I2: ported to the documented ownership contract (SPEC §19.4): valid library use never
 *   changes a published version; mutating a borrowed read-only view through JavaScript is
 *   outside the contract, so the unguarded write is reported as an observation, not a failure.
 * - P1: the old node-table export was replaced by `exportDocument(..., "rowProjection")`; the
 *   probe now checks real expressiveness: a mixed-text document validates against the emitted
 *   grammar and round-trips through the paired decoder.
 * All other probes are unchanged. Run by MR44 against the built package.
 *
 * Original header:
 * Read-only review probes for AnimaticML/ml-collab-codec.
 * Source inspected: 73a782d17961b086d6e05a2fb65a3e0bf288f231.
 * These assertions describe the intended public contracts, not passing baselines.
 * Prepared during a static review; NOT executed against the built package here.
 * Syntax checked with Node.js. No repository files are modified by this script.
 *
 * Usage, after building the checkout:
 *   node /path/to/ml-collab-codec-review-probes.mjs /path/to/repo/dist/index.js
 * Expected after fixes: all probes pass. Existing failures are reported individually.
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) {
  console.error("Usage: node ml-collab-codec-review-probes.mjs /path/to/repo/dist/index.js");
  process.exit(2);
}
const lib = await import(pathToFileURL(resolve(entry)).href);
const probes = [];
const observations = [];
const test = (name, fn) => probes.push({ name, fn });

function schema(opaque = false) {
  const textComponent = (tag) => ({
    tag,
    identity: "stable",
    properties: {
      title: { type: "string", required: true },
      opacity: { type: "number", default: 1 },
      tags: { type: "array", items: { type: "string" }, default: [] },
      config: { type: "object", properties: { size: { type: "number" } } },
    },
    content: { mode: "mixed" },
    ...(opaque ? { allowOpaqueProperties: true } : {}),
  });
  return lib.registerSchema({
    id: "review.fixture",
    version: "1",
    rootTag: "doc",
    unknownPolicy: "error",
    components: {
      doc: {
        tag: "doc",
        identity: "none",
        properties: {},
        content: { mode: "element", allowedTags: ["p", "heading"] },
      },
      p: textComponent("p"),
      heading: textComponent("heading"),
    },
  });
}
function parse(source, profile) {
  const result = lib.parseDocument(source, profile);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.value;
}
function fixture(opaque = false) {
  const profile = schema(opaque);
  const model = parse('<doc><p id="p1" title="Intro">Hello</p></doc>', profile);
  const table = lib.toTable(model, lib.createAllocator());
  return { profile, model, table };
}
function paragraph(root) {
  const result = root.content.find((x) => typeof x !== "string" && x.id === "p1");
  assert.ok(result, "fixture paragraph exists");
  return result;
}
function makeClient(table) {
  return new lib.Client({
    documentId: "review-document",
    historyEpoch: "review-epoch",
    allocator: lib.SequenceAllocator.ephemeral("review-replica"),
    actor: "review-user",
    table,
    revision: 0,
  });
}

// Schema and validation must cover nested data, not just container types.
test("V1: parse rejects a number inside an array declared string[]", () => {
  const result = lib.parseDocument(
    '<doc><p id="p1" title="Intro"><script type="application/json">{"tags":[42]}</script>Hello</p></doc>',
    schema(),
  );
  assert.equal(result.ok, false, "invalid item type was accepted");
});
test("V2: strict nested properties are rejected instead of silently discarded", () => {
  const result = lib.parseDocument(
    '<doc><p id="p1" title="Intro"><script type="application/json">{"config":{"size":10,"unrecognized":"KEEP"}}</script>Hello</p></doc>',
    schema(),
  );
  assert.equal(result.ok, false, "unknown nested data was accepted and may be lost");
});
test("V3: validateDocument checks declared property types", () => {
  const { profile, model } = fixture();
  const target = structuredClone(model.root);
  paragraph(target).props.opacity = "not a number";
  const issues = lib.validateDocument(target, profile);
  assert.ok(issues.length > 0, "validator reports no error for an invalid property type");
});
test("V4: recommended authority schema validator rejects an invalid set", () => {
  const { profile, table } = fixture();
  const authority = lib.Authority.create("review-document", "review-epoch", table, {
    validators: [lib.schemaValidator(profile)],
  });
  const changes = new lib.ChangeBuilder(table, { replica: "review-replica", seq: 1 }).set(
    "p1",
    "opacity",
    "not a number",
  ).changes;
  const result = authority.submit(
    {
      profile: lib.CONTROL_PROFILE,
      opFormat: lib.OPERATION_FORMAT,
      documentId: "review-document",
      historyEpoch: "review-epoch",
      replica: "review-replica",
      seq: 1,
      baseRevision: 0,
      changes,
      meta: {},
    },
    { actor: "review-user" },
  );
  assert.equal(result.kind, "decided");
  assert.equal(result.receipt.outcome, "rejected", "schema-invalid state was admitted");
});

// Published snapshots and their retained inputs must not be externally mutable.
test("I1: valid library use never changes a published snapshot (child lists)", () => {
  const { table } = fixture();
  const client = makeClient(table);
  const snapshot = client.getSnapshot();
  const before = JSON.stringify([...snapshot.table.values()]);
  client.transact((b) => b.insertNode("p1", 0, "inserted"));
  client.transact((b) => b.moveNode(snapshot.table.get("p1").children[0], "p1", 2));
  assert.equal(JSON.stringify([...snapshot.table.values()]), before, "an old version changed");
  assert.ok(Object.isFrozen(snapshot.table.get("p1")), "rows are frozen");
  // Observation only (outside the contract): deliberate writes through a borrowed array.
  const children = snapshot.table.get("p1").children;
  let guarded = false;
  try {
    children.push("externally-inserted-child");
  } catch {
    guarded = true;
  }
  observations.push(
    `I1 child-array write through a cast: ${guarded ? "guarded" : "not guarded (outside contract)"}`,
  );
});
test("I2: valid library use never changes array-valued props of a published snapshot", () => {
  const { table } = fixture();
  const client = makeClient(table);
  const snapshot = client.getSnapshot();
  const tags = snapshot.table.get("p1").props.tags;
  assert.ok(Array.isArray(tags));
  client.transact((b) => b.arrayInsert("p1", ["tags"], 0, ["added"]));
  assert.deepEqual(snapshot.table.get("p1").props.tags, [], "an old version changed");
  assert.deepEqual(client.getSnapshot().table.get("p1").props.tags, ["added"]);
  const copy = lib.editableCopy(lib.fromTable(snapshot.table, "review.fixture", "1"));
  paragraph(copy.root).props.tags.push("free-edit");
  assert.deepEqual(snapshot.table.get("p1").props.tags, [], "an editable copy aliased the base");
});
test("I3: retaining and modifying an input model cannot alter an operational table", () => {
  const { model, table } = fixture();
  const before = table.get("p1").props.opacity;
  try {
    paragraph(model.root).props.opacity = 0.25;
  } catch {
    /* guarded input ownership */
  }
  assert.equal(table.get("p1").props.opacity, before, "table aliases mutable input props");
});

// Losslessness is a separate contract from ordinary successful parse tests.
test("C1: explicitly permitted opaque properties survive parse/serialize/parse", () => {
  const profile = schema(true);
  const first = parse('<doc><p id="p1" title="Intro" extra="KEEP">Hello</p></doc>', profile);
  assert.equal(paragraph(first.root).props.extra, "KEEP");
  const second = parse(lib.serializeDocument(first, profile), profile);
  assert.equal(paragraph(second.root).props.extra, "KEEP", "serializer dropped permitted data");
});
test("D1: diff satisfies the transition law for a valid same-ID tag change", () => {
  const { profile, model, table } = fixture();
  const target = structuredClone(model.root);
  paragraph(target).tag = "heading";
  const changes = lib.diffToChanges(table, target, { replica: "review-replica", seq: 1 });
  const result = lib.fromTable(lib.applyChanges(table, changes), profile.id, profile.version);
  assert.deepEqual(result.root, target, "diff returned a successful but incomplete transition");
});

// The emitted grammar must allow the text rows its paired decoder expects.
test("P1: the document projection export can represent mixed text", () => {
  const profile = schema();
  const exported = lib.exportDocument(profile, "gemini", "rowProjection");
  const model = parse('<doc><p id="p1" title="Intro">Hello mixed text</p></doc>', profile);
  const wire = lib.encodeProviderOutput(exported, model, profile);
  assert.ok(
    wire.rows.some((row) => typeof row.text === "string"),
    "no text rows emitted",
  );
  const decoded = lib.decodeProviderOutput(exported, wire, profile);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.diagnostics));
  assert.deepEqual(decoded.value, model, "mixed text did not round-trip");
});

// An async result must wake computations which previously read its pending state.
test("R1: asynchronous layout completion invalidates its derived consumers", () => {
  const { table } = fixture();
  const graph = new lib.DerivedGraph(table);
  const run = table.get("p1").children[0];
  let complete;
  graph.defineAsync("layout", (ctx, done) => {
    ctx.text(run);
    complete = done;
  });
  graph.define("width", (ctx) => {
    const state = ctx.derived("layout");
    return state.status === "ready" ? state.value.width : "pending";
  });
  assert.equal(graph.read("width"), "pending");
  assert.equal(typeof complete, "function");
  complete({ width: 100 });
  graph.flush();
  assert.equal(graph.read("width"), 100, "dependent cache remained pending after completion");
});

let failures = 0;
for (const { name, fn } of probes) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n  ${error?.stack ?? error}`);
  }
}
for (const note of observations) console.log(`NOTE ${note}`);
console.log(`\n${probes.length - failures} passed; ${failures} failed; ${probes.length} probes.`);
if (failures > 0) process.exitCode = 1;
process.exitCode = failures ? 1 : 0;
