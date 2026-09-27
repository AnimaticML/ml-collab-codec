// A separate "consumer" of the built package (SPEC 15/Q02, R34): public imports
// only, real generic APIs. Covers rich text, numeric board, hidden hand,
// indexed array editing, grouped typing/drag, undo/redo after remote work,
// anchor/proposal rebase, counted notification batching, runtime adapters,
// and standalone local save/reopen without a room.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineDocumentSchema,
  parseDocument,
  serializeDocument,
  toTable,
  fromTable,
  createAllocator,
  Authority,
  Client,
  SequenceAllocator,
  RestrictedAuthority,
  proposeEdit,
  rebaseProposal,
  mapAnchor,
  wrapText,
  DerivedGraph,
  ClassProjection,
  createSelector,
  schemaValidator,
} from "../../dist/index.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

/** A minimal in-process room: every client's next request is admitted and events are broadcast. */
function room(table, names, options = {}) {
  const authority = Authority.create("consumer-doc", "epoch-1", table, options);
  const clients = Object.fromEntries(
    names.map((name) => [
      name,
      new Client({
        documentId: "consumer-doc",
        historyEpoch: "epoch-1",
        allocator: SequenceAllocator.ephemeral(`replica-${name}`),
        actor: name,
        table,
        revision: 0,
      }),
    ]),
  );
  const settle = () => {
    for (let moved = true; moved;) {
      moved = false;
      for (const [name, client] of Object.entries(clients)) {
        const request = client.nextRequest();
        if (request === undefined) continue;
        moved = true;
        const decision = authority.submit(request, { actor: name });
        if (decision.transition)
          for (const peer of Object.values(clients)) peer.receive(decision.transition);
        client.receive(decision.receipt);
      }
    }
  };
  return { authority, clients, settle };
}

const closed = { type: "object", properties: {}, additionalProperties: false };
const richText = defineDocumentSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "consumer.rich-text",
  version: "1.0.0",
  rootTag: "doc",
  components: {
    doc: { identity: "none", content: { mode: "mixed", allowedTags: ["p"] }, props: closed },
    p: { identity: "stable", content: { mode: "mixed", allowedTags: ["em"] }, props: closed },
    em: { identity: "none", content: { mode: "mixed" }, props: closed },
  },
});
const print = (table) =>
  serializeDocument(fromTable(table, richText.id, richText.version), richText);
const base = parseDocument(`<doc><p id="p1">Payment in 10 days.</p></doc>`, richText);
check(base.ok, "rich-text base parse failed");
const baseTable = toTable(base.value, createAllocator());
const run = baseTable.get("p1").children[0];

// Rich text: wrap versus replace, then undo after remote work, then redo.
const text = room(baseTable, ["alice", "bob"]);
text.clients.alice.transact((b) => void wrapText(b, run, 11, 13, { tag: "em" }));
text.clients.bob.transact((b) => b.textReplace(run, 11, 13, "15"));
text.settle();
check(
  print(text.authority.getTable()) === '<doc><p id="p1">Payment in <em>15</em> days.</p></doc>',
  "wrap/replace: " + print(text.authority.getTable()),
);
text.clients.bob.transact((b) => b.textInsert(run, 0, ">"));
text.settle();
check(text.clients.alice.undo().status === "requested", "undo after remote work");
text.settle();
check(
  print(text.authority.getTable()) === '<doc><p id="p1">&gt;Payment in 15 days.</p></doc>',
  "undo: " + print(text.authority.getTable()),
);
text.clients.alice.redo();
text.settle();
check(print(text.clients.bob.getSnapshot().table).includes("<em>15</em>"), "redo");

// Grouped typing and a counted notification batch.
let commits = 0;
text.clients.alice.subscribeCommits(() => (commits += 1));
text.clients.alice.transact((b) => {
  for (const [i, ch] of [..."abc"].entries()) b.textInsert(run, i, ch);
});
check(commits === 1, "one publication per batch");
text.settle();

// Anchor mapping and an agent proposal rebased from its read base.
const agent = parseDocument(`<doc><p id="p1">Payment in 30 days.</p></doc>`, richText);
check(agent.ok, "agent parse");
const proposalRoom = room(baseTable, ["human"]);
const anchor = { kind: "point", node: run, offset: 0, affinity: "after" };
proposalRoom.clients.human.transact((b) => b.textInsert(run, 0, "Net: "));
proposalRoom.settle();
check(
  mapAnchor(
    anchor,
    proposalRoom.authority.transitionsSince(0).flatMap((t) => t.changes),
  ).anchor.offset === 5,
  "anchor",
);
const rebased = rebaseProposal(
  proposeEdit({ table: baseTable, revision: 0 }, agent.value.root, {
    replica: "replica-agent",
    seq: 1,
  }),
  proposalRoom.authority,
);
check(rebased.status === "rebased", "proposal rebase");

// Numeric board with additive deltas and indexed array editing of equal values.
const board = defineDocumentSchema({
  id: "consumer.board",
  version: "1.0.0",
  rootTag: "board",
  components: {
    board: {
      identity: "none",
      content: { mode: "element", allowedTags: ["cell"] },
      props: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 1, "x-encoding": "comma" },
        },
        additionalProperties: false,
      },
    },
    cell: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { value: { type: "integer", default: 0, "x-additive": true } },
        additionalProperties: false,
      },
    },
  },
});
const boardParsed = parseDocument(`<board tags="a,a,b"><cell id="c1" value="10" /></board>`, board);
check(boardParsed.ok, "board parse failed");
const boardRoom = room(toTable(boardParsed.value, createAllocator()), ["a", "b"], {
  validators: [schemaValidator(board)],
});
boardRoom.clients.a.transact((b) => b.delta("c1", "value", 2).arrayDelete("$root", ["tags"], 0));
boardRoom.clients.b.transact((b) => b.delta("c1", "value", 3).arrayDelete("$root", ["tags"], 1));
boardRoom.settle();
check(boardRoom.authority.getTable().get("c1").props.value === 15, "board deltas");
check(
  JSON.stringify(boardRoom.authority.getTable().get("$root").props.tags) === '["b"]',
  "indexed array deletes",
);

// Drag gesture: one explicit group, undone at once.
const drag = boardRoom.clients.a;
drag.beginGroup("drag");
for (const step of [1, 2, 3]) {
  drag.transact((b) => b.delta("c1", "value", step));
  boardRoom.settle();
}
drag.endGroup();
drag.undo();
boardRoom.settle();
check(boardRoom.authority.getTable().get("c1").props.value === 15, "drag undo");

// Runtime adapters: projection, derived graph with a fake scheduler, and a selector.
const tasks = [];
const graph = new DerivedGraph(drag.getSnapshot().table, {
  schedule: (task) => (tasks.push(task), () => undefined),
});
let computed = 0;
graph.define("value", (ctx) => ((computed += 1), ctx.prop("c1", ["value"])));
graph.read("value");
const projection = new ClassProjection(drag, {
  accepts: (row) => row.tag === "cell",
  create: () => ({
    install(row) {
      this.value = row.props.value;
    },
  }),
  graph,
});
const selector = createSelector(
  drag,
  (s) => [s.table.get("c1")],
  (row) => row.props.value,
);
drag.transact((b) => b.delta("c1", "value", 1));
drag.transact((b) => b.delta("c1", "value", 1));
tasks.splice(0).forEach((task) => task());
check(
  computed === 2 &&
    graph.read("value") === 17 &&
    projection.get("c1").value === 17 &&
    selector.get() === 17,
  "runtime adapters",
);

// Hidden hand: restricted regions and a trusted action.
const required = (name) => ({
  type: "object",
  properties: { [name]: { type: "string" } },
  required: [name],
  additionalProperties: false,
});
const hidden = defineDocumentSchema({
  id: "consumer.hidden",
  version: "1.0.0",
  rootTag: "game",
  components: {
    game: {
      identity: "none",
      content: { mode: "element", allowedTags: ["table", "hand"] },
      props: closed,
    },
    table: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["card"] },
      props: closed,
    },
    hand: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["card"] },
      regionOwner: "owner",
      props: required("owner"),
    },
    card: { identity: "stable", content: { mode: "none" }, props: required("rank") },
  },
});
const gameParsed = parseDocument(
  `<game><table id="t1" /><hand id="h1" owner="alice"><card id="c1" rank="Q" /></hand></game>`,
  hidden,
);
check(gameParsed.ok, "hidden-hand parse failed");
const game = new RestrictedAuthority(
  hidden,
  "game",
  "epoch-1",
  toTable(gameParsed.value, createAllocator()),
);
game.registerAction("play", (table, principal, params, builder) => {
  const card = table.get(String(params.cardId));
  const hand = card ? table.get(card.parentId) : undefined;
  if (!hand || hand.props.owner !== principal) return false;
  builder.moveNode(card.id, "t1", 0);
  return true;
});
check(
  game.submitAction("bob", "play", { cardId: "c1" }, { replica: "replica-bob", seq: 1 }).decision
    .receipt.outcome === "rejected",
  "hidden-hand should deny bob",
);
check(
  !JSON.stringify(game.view("observer")).includes('"Q"'),
  "observer must not see the private card",
);
check(
  game.submitAction("alice", "play", { cardId: "c1" }, { replica: "replica-alice", seq: 1 })
    .decision.receipt.outcome === "applied",
  "hidden-hand should allow alice",
);
check(game.view("observer").has("c1"), "card should be public after play");

// Standalone local file: save and reopen without a room, history, or server.
const dir = mkdtempSync(join(tmpdir(), "consumer-check-"));
const path = join(dir, "doc.txt");
writeFileSync(path, print(text.authority.getTable()), "utf8");
check(parseDocument(readFileSync(path, "utf8"), richText).ok, "standalone reopen failed");

console.log("CONSUMER_CHECK_OK");
