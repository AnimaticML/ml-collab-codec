import assert from "node:assert/strict";
import {
  Authority,
  ROOT_ID,
  createAllocator,
  decodeDocumentJson,
  defineDocumentSchema,
  fromTable,
  parseDocument,
  serializeDocument,
  toTable,
} from "ml-collab-codec";
import { component, join, object, submit, value } from "./lib/composition.mjs";

const world = {
  name: "interview-world",
  declaration: "1.0.0",
  implementation: "1.0.0",
  components: {
    interviewWorld: component(
      object({ worldKey: { type: "string", "x-reference": "definition" } }),
      ["interviewPerson"],
    ),
    interviewPerson: component(object({ name: { type: "string" } })),
  },
};
const animatic = {
  name: "animatic-camera",
  declaration: "1.0.0",
  implementation: "1.0.0",
  components: {
    animaticOccurrence: component(
      object({
        world: { type: "string", "x-reference": "reference" },
        near: { type: "number", minimum: 0 },
        far: { type: "number", minimum: 0 },
      }),
    ),
  },
};

function assemble(dependencies) {
  const components = {
    interview: component(
      object({
        title: { type: "string" },
        dependencies: { type: "array", items: dependencySchema },
      }),
      ["interviewWorld", "animaticOccurrence"],
    ),
  };
  for (const dependency of dependencies)
    for (const [tag, definition] of Object.entries(dependency.components)) {
      if (Object.hasOwn(components, tag)) throw new Error(`Duplicate component tag: ${tag}`);
      components[tag] = definition;
    }
  return defineDocumentSchema({ id: "interview", version: "1", rootTag: "interview", components });
}

const dependencySchema = object({
  name: { type: "string" },
  declaration: { type: "string" },
  implementation: { type: "string" },
});
const dependencies = [world, animatic].map(({ name, declaration, implementation }) => ({
  name,
  declaration,
  implementation,
}));
const profile = assemble([world, animatic]);
assert.throws(() => assemble([world, world, animatic]), /Duplicate component tag/);

const initial = {
  schemaId: profile.id,
  schemaVersion: profile.version,
  root: {
    tag: "interview",
    id: "interview-1",
    props: { title: "Interview", dependencies },
    content: [
      {
        tag: "interviewWorld",
        id: "world-1",
        props: { worldKey: "interview-set" },
        content: [
          { tag: "interviewPerson", id: "speaker", props: { name: "Speaker" } },
          { tag: "interviewPerson", id: "interviewer", props: { name: "Interviewer" } },
        ],
      },
      {
        tag: "animaticOccurrence",
        id: "shot",
        props: { world: "interview-set", near: 1, far: 10 },
      },
      {
        tag: "animaticOccurrence",
        id: "reverse",
        props: { world: "interview-set", near: 2, far: 20 },
      },
    ],
  },
};

function validateInterview(candidate) {
  if (JSON.stringify(candidate.get(ROOT_ID)?.props.dependencies) !== JSON.stringify(dependencies))
    return "The host requires the recorded dependency versions";
  for (const node of candidate.values()) {
    if (node.tag === "animaticOccurrence" && node.props.near >= node.props.far)
      return "Camera near plane must precede far plane";
  }
  return null;
}

function cameraAction(client, installed, id, near, far) {
  const expected = client
    .getSnapshot()
    .table.get(ROOT_ID)
    .props.dependencies.find((dependency) => dependency.name === animatic.name);
  const implementation = installed.get(animatic.name);
  if (
    implementation === undefined ||
    implementation.declaration !== expected?.declaration ||
    implementation.implementation !== expected.implementation
  )
    return "Camera implementation unavailable";
  return client.transact((builder) => {
    builder.set(id, "near", near);
    builder.set(id, "far", far);
  });
}

const source = serializeDocument(value(decodeDocumentJson(initial, profile)), profile);
const authority = Authority.create(
  "interview-1",
  "epoch-1",
  toTable(value(parseDocument(source, profile)), createAllocator()),
  { schema: profile, validators: [validateInterview] },
);
const alice = join(authority, "alice");
const bob = join(authority, "bob");
const installed = new Map([[animatic.name, animatic]]);
const shot = cameraAction(alice, installed, "shot", 12, 30);
assert.equal(shot.status, "applied");
assert.equal(submit(authority, alice, [bob]).outcome, "applied");
assert.equal(authority.getRevision(), 1);
assert.equal(authority.transitionsSince(0)[0].changes.length, 2);

bob.transact((builder) => builder.set("reverse", "far", 22));
assert.equal(submit(authority, bob, [alice]).outcome, "applied");
bob.transact((builder) => builder.set("reverse", "near", 99));
assert.equal(submit(authority, bob, [alice]).outcome, "rejected");
bob.transact((builder) => builder.set("reverse", "world", "missing-world"));
assert.equal(submit(authority, bob, [alice]).outcome, "rejected");
assert.equal(alice.undo(shot.group).status, "requested");
assert.equal(submit(authority, alice, [bob]).outcome, "applied");

const saved = fromTable(authority.getTable(), profile.id, profile.version);
const sourceReopened = value(parseDocument(serializeDocument(saved, profile), profile));
const jsonReopened = value(decodeDocumentJson(JSON.parse(JSON.stringify(saved)), profile));
for (const reopened of [sourceReopened, jsonReopened]) {
  const table = toTable(reopened, createAllocator());
  assert.equal(reopened.root.id, "interview-1");
  assert.equal(table.get("world-1").props.worldKey, "interview-set");
  assert.equal(table.get("speaker").props.name, "Speaker");
  assert.equal(table.get("interviewer").props.name, "Interviewer");
  assert.deepEqual(table.get("shot").props, { world: "interview-set", near: 1, far: 10 });
  assert.deepEqual(table.get("reverse").props, { world: "interview-set", near: 2, far: 22 });
  assert.deepEqual(reopened.root.props.dependencies, dependencies);
}

// Keep the declaration and validators installed while reopening without camera behavior.
const reopened = Authority.create(
  "interview-1",
  "epoch-2",
  toTable(jsonReopened, createAllocator()),
  {
    schema: profile,
    validators: [validateInterview],
  },
);
const offline = join(reopened, "offline");
assert.equal(cameraAction(offline, new Map(), "shot", 3, 18), "Camera implementation unavailable");
offline.transact((builder) => builder.set(ROOT_ID, "title", "Reopened interview"));
assert.equal(submit(reopened, offline).outcome, "applied");
offline.transact((builder) => builder.set("shot", "far", 18));
assert.equal(submit(reopened, offline).outcome, "applied");
assert.equal(reopened.getTable().get("world-1").props.worldKey, "interview-set");
console.log("INTERVIEW_COMPOSITION_OK");
