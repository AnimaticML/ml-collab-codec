import assert from "node:assert/strict";
import {
  Authority,
  ROOT_ID,
  createAllocator,
  defineDocumentSchema,
  exportCheckpoint,
  fromTable,
  parseDocument,
  restoreAuthority,
  serializeDocument,
  toTable,
  validateTable,
} from "ml-collab-codec";
import { component, join, object, submit, value } from "./lib/composition.mjs";

const charges = { type: "integer", minimum: 0 };
const pin = { name: "charge-card", declaration: "1.0.0", implementation: "1.0.0" };
const pinSchema = object({
  name: { type: "string" },
  declaration: { type: "string" },
  implementation: { type: "string" },
});
const baseProps = object(
  { round: { type: "integer", minimum: 1 }, title: { type: "string" }, dependency: pinSchema },
  ["round", "title"],
);

function profile(tags, extra = {}, unknownComponents = "reject") {
  return defineDocumentSchema({
    id: "tabletop",
    version: "1",
    rootTag: "tabletop",
    unknownComponents,
    components: {
      tabletop: {
        ...component(baseProps),
        content: { mode: "element", ...(tags === undefined ? {} : { allowedTags: tags }) },
      },
      basicCard: component(object({ title: { type: "string" } })),
      ...extra,
    },
  });
}

const storage = profile(undefined, {}, "preserve");
const base = profile(["basicCard"]);
const cardModule = {
  pin,
  profile: profile(["basicCard", "chargeCard"], {
    chargeCard: component(object({ charges })),
  }),
  spend(client, id) {
    const card = client.getSnapshot().table.get(id);
    assert.equal(card?.tag, "chargeCard");
    assert.ok(card.props.charges > 0);
    return client.transact((builder) => builder.set(id, "charges", card.props.charges - 1));
  },
};

function lookup(dependency, catalog) {
  if (dependency === undefined) return { status: "base", profile: base };
  const installed = catalog.get(dependency.name);
  if (installed === undefined) return { status: "missing" };
  if (
    installed.pin.declaration !== dependency.declaration ||
    installed.pin.implementation !== dependency.implementation
  )
    return { status: "incompatible" };
  return { status: "available", profile: installed.profile, module: installed };
}

function validator(catalog) {
  return (candidate) => {
    const resolved = lookup(candidate.get(ROOT_ID).props.dependency, catalog);
    if (resolved.profile === undefined) return `Dependency ${resolved.status}`;
    return validateTable(candidate, resolved.profile)[0]?.message ?? null;
  };
}

function activeClient(authority, catalog, actor) {
  const resolved = lookup(authority.getTable().get(ROOT_ID).props.dependency, catalog);
  assert.ok(resolved.profile, `Dependency ${resolved.status}`);
  assert.deepEqual(validateTable(authority.getTable(), resolved.profile), []);
  return join(authority, actor);
}

function spend(client, catalog, id) {
  const resolved = lookup(client.getSnapshot().table.get(ROOT_ID).props.dependency, catalog);
  if (resolved.module === undefined) return resolved.status;
  return resolved.module.spend(client, id);
}

function installCard(client, dependency) {
  return client.transact((builder) => {
    builder.set(ROOT_ID, "dependency", dependency);
    builder.insertNode(ROOT_ID, 1, { id: "charge-1", tag: "chargeCard", props: { charges: 3 } });
  });
}

const start = value(
  parseDocument(
    '<tabletop id="game" round="7" title="Campaign"><basicCard id="existing" title="Scout" /></tabletop>',
    storage,
  ),
);
const trustedCatalog = new Map();
const authority = Authority.create("game", "epoch-1", toTable(start, createAllocator()), {
  schema: storage,
  validators: [validator(trustedCatalog)],
});
const aliceCatalog = new Map();
const bobCatalog = new Map();
const alice = activeClient(authority, aliceCatalog, "alice");
const bob = activeClient(authority, bobCatalog, "bob");
installCard(alice, pin);
assert.equal(submit(authority, alice, [bob]).reason, "Dependency missing");

trustedCatalog.set(pin.name, cardModule);
aliceCatalog.set(pin.name, cardModule);
bobCatalog.set(pin.name, cardModule);
installCard(alice, { ...pin, implementation: "2.0.0" });
assert.equal(submit(authority, alice, [bob]).reason, "Dependency incompatible");

alice.closeGroup();
const addition = installCard(alice, pin);
bob.transact((builder) => builder.set(ROOT_ID, "title", "Campaign continued"));
assert.equal(submit(authority, alice, [bob]).outcome, "applied");
assert.equal(submit(authority, bob, [alice]).outcome, "applied");

// Undo the whole addition while there are no dependent edits, then redo it.
assert.equal(alice.undo(addition.group).status, "requested");
assert.equal(submit(authority, alice, [bob]).outcome, "applied");
assert.equal(authority.getTable().get("charge-1"), undefined);
assert.equal(authority.getTable().get(ROOT_ID).props.dependency, undefined);
assert.equal(authority.getTable().get(ROOT_ID).props.title, "Campaign continued");
assert.equal(alice.redo(addition.group).status, "requested");
assert.equal(submit(authority, alice, [bob]).outcome, "applied");

assert.equal(spend(bob, bobCatalog, "charge-1").status, "applied");
assert.equal(submit(authority, bob, [alice]).outcome, "applied");
assert.equal(authority.getTable().get("charge-1").props.charges, 2);
alice.transact((builder) => builder.set(ROOT_ID, "dependency", undefined));
assert.equal(submit(authority, alice, [bob]).outcome, "rejected");
const undoAfterSpend = alice.undo(addition.group);
assert.equal(undoAfterSpend.status, "conflict");
assert.equal(authority.getTable().get("charge-1").props.charges, 2);

const checkpoint = exportCheckpoint(authority, storage, authority.getRevision());
const reopened = restoreAuthority(JSON.parse(JSON.stringify(checkpoint)), [], storage, {
  validators: [validator(trustedCatalog)],
});
assert.equal(reopened.getRevision(), authority.getRevision());
assert.deepEqual(reopened.transitionsSince(0), authority.transitionsSince(0));

const saved = fromTable(reopened.getTable(), storage.id, storage.version);
const source = serializeDocument(saved, storage);
const recovered = value(parseDocument(source, storage));
assert.equal(recovered.root.id, "game");
assert.equal(recovered.root.props.round, 7);
assert.equal(recovered.root.props.title, "Campaign continued");
assert.deepEqual(recovered.root.props.dependency, pin);
assert.equal(reopened.getTable().get("existing").props.title, "Scout");
assert.equal(toTable(recovered, createAllocator()).get("charge-1").props.charges, 2);

const reader = activeClient(reopened, aliceCatalog, "reader");
assert.equal(spend(reader, new Map(), "charge-1"), "missing");
const incompatible = new Map([
  [pin.name, { ...cardModule, pin: { ...pin, declaration: "2.0.0" } }],
]);
assert.equal(spend(reader, incompatible, "charge-1"), "incompatible");
assert.throws(() => activeClient(reopened, new Map(), "missing"), /Dependency missing/);
assert.throws(
  () => activeClient(reopened, incompatible, "incompatible"),
  /Dependency incompatible/,
);
assert.equal(spend(reader, aliceCatalog, "charge-1").status, "applied");
assert.equal(submit(reopened, reader).outcome, "applied");
assert.equal(reopened.getTable().get("charge-1").props.charges, 1);
console.log("TABLETOP_EVOLUTION_OK");
