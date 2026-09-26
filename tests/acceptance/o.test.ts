import { expect, test } from "bun:test";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import type { Change } from "../../src/core/change.ts";
import type { ChangeBuilder as Builder } from "../../src/core/builder.ts";
import { wrapText } from "../../src/core/builder-rich.ts";
import { diffToChanges } from "../../src/core/diff.ts";
import { schemaInvariants } from "../../src/core/invariants.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { proposeEdit, rebaseProposal } from "../../src/core/proposal.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import type { Table } from "../../src/core/table.ts";
import { createAllocator, fromTable, ROOT_ID, textOf, toTable } from "../../src/core/table.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { childrenDoc, items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

function outcome(decision: Decision): string {
  return decision.kind === "decided" ? decision.receipt.outcome : decision.kind;
}

/** Concurrent requests from revision 0, admitted in array order. */
function concurrent(
  table: Table,
  requests: readonly (readonly [string, (b: Builder) => void])[],
  validated = false,
) {
  const auth = Authority.create(
    DOC,
    EPOCH,
    table,
    validated ? { validators: [schemaInvariants(listSchema)] } : {},
  );
  const outcomes = requests.map(([replica, commands]) =>
    outcome(
      auth.submit(envelope(replica, 1, 0, build(table, replica, 1, commands)), { actor: replica }),
    ),
  );
  return { auth, outcomes };
}

function rich(source: string): Table {
  const parsed = parseDocument(source, richTextSchema);
  if (!parsed.ok) throw new Error("fixture");
  return toTable(parsed.value, createAllocator());
}

function print(table: Table): string {
  return serializeDocument(
    fromTable(table, richTextSchema.id, richTextSchema.version),
    richTextSchema,
  );
}

const count = listDoc({ count: 10 });

test("O01 Additive numeric concurrency", () => {
  const { auth, outcomes } = concurrent(
    count,
    [
      ["replica-a", (b) => b.delta(ROOT_ID, "count", 2)],
      ["replica-b", (b) => b.delta(ROOT_ID, "count", 3)],
    ],
    true,
  );
  expect(outcomes).toEqual(["applied", "applied"]);
  expect(auth.getTable().get(ROOT_ID)?.props["count"]).toBe(15);
});

test("O02 Delta delivery is deduplicated", () => {
  const auth = Authority.create(DOC, EPOCH, count);
  const plusTwo = build(count, "replica-a", 1, (b) => b.delta(ROOT_ID, "count", 2));
  const first = auth.submit(envelope("replica-a", 1, 0, plusTwo), { actor: "a" });
  const dup = auth.submit(envelope("replica-a", 1, 0, plusTwo), { actor: "a" });
  const distinct = auth.submit(
    envelope(
      "replica-a",
      2,
      0,
      build(count, "replica-a", 2, (b) => b.delta(ROOT_ID, "count", 2)),
    ),
    { actor: "a" },
  );
  expect(dup.kind === "decided" ? dup.receipt : undefined).toEqual(
    first.kind === "decided" ? first.receipt : undefined,
  );
  expect(outcome(distinct)).toBe("applied");
  expect(auth.getTable().get(ROOT_ID)?.props["count"]).toBe(14);
  expect(auth.getRevision()).toBe(2);
});

test("O03 Set versus delta conflict", () => {
  const { auth, outcomes } = concurrent(count, [
    ["replica-a", (b) => b.set(ROOT_ID, "count", 20)],
    ["replica-b", (b) => b.delta(ROOT_ID, "count", 3)],
  ]);
  expect(outcomes).toEqual(["applied", "rejected"]);
  expect(auth.getTable().get(ROOT_ID)?.props["count"]).toBe(20);
});

const pairList = listDoc({ items: ["a", "b"] });
const removeAt = (index: number) => (b: Builder) => void b.arrayDelete(ROOT_ID, ["items"], index);

test("O04 Minimum collection, A first", () => {
  const { auth, outcomes } = concurrent(
    pairList,
    [
      ["replica-a", removeAt(0)],
      ["replica-b", removeAt(1)],
    ],
    true,
  );
  expect(outcomes).toEqual(["applied", "rejected"]);
  expect(items(auth.getTable())).toEqual(["b"]);
});

test("O05 Minimum collection, B first", () => {
  const { auth, outcomes } = concurrent(
    pairList,
    [
      ["replica-b", removeAt(1)],
      ["replica-a", removeAt(0)],
    ],
    true,
  );
  expect(outcomes).toEqual(["applied", "rejected"]);
  expect(items(auth.getTable())).toEqual(["a"]);
});

test("O06 Already removed is satisfied", () => {
  const { auth, outcomes } = concurrent(
    pairList,
    [
      ["replica-a", removeAt(0)],
      ["replica-b", removeAt(0)],
    ],
    true,
  );
  expect(outcomes).toEqual(["applied", "alreadySatisfied"]);
  expect(items(auth.getTable())).toEqual(["b"]);
});

test("O07 Concurrent insertion order", () => {
  const kids = childrenDoc(["A", "B"]);
  const x = [
    "replica-a",
    (b: Builder) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "X", props: { label: "X" } }),
  ] as const;
  const y = [
    "replica-b",
    (b: Builder) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "Y", props: { label: "Y" } }),
  ] as const;
  for (const order of [
    [x, y],
    [y, x],
  ]) {
    const room = new Room(kids);
    for (const [replica, commands] of order) room.join(replica, replica).transact(commands);
    for (const [replica] of order) room.send(replica);
    room.settle();
    for (const member of room.members.values())
      expect(member.client.getSnapshot().table.get(ROOT_ID)?.children).toEqual([
        "A",
        "X",
        "Y",
        "B",
      ]);
    expect(room.authority.getRevision()).toBe(2);
  }
});

test("O08 Deletion preserves concurrent insertions", () => {
  const text = textDoc("abcd");
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const requests: [string, (b: Builder) => void][] = [
      ["replica-a", (b) => b.textDelete("t", 1, 2)],
      ["replica-b", (b) => b.textInsert("t", 2, "X")],
    ];
    const { auth, outcomes } = concurrent(
      text,
      order.map((i) => requests[i] as (typeof requests)[number]),
    );
    expect(outcomes).toEqual(["applied", "applied"]);
    expect(textOf(auth.getTable().get("t"))).toBe("aXd");
  }
});

test("O09 Move with descendant edit", () => {
  const table = rich(`<doc><p id="other">x</p><p id="moved">hi</p></doc>`);
  const run = table.get("moved")?.children[0] ?? "";
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const requests: [string, (b: Builder) => void][] = [
      ["replica-a", (b) => b.moveNode("moved", ROOT_ID, 0)],
      ["replica-b", (b) => b.textInsert(run, 2, "!")],
    ];
    const { auth, outcomes } = concurrent(
      table,
      order.map((i) => requests[i] as (typeof requests)[number]),
    );
    expect(outcomes).toEqual(["applied", "applied"]);
    expect(print(auth.getTable())).toBe('<doc><p id="moved">hi!</p><p id="other">x</p></doc>');
  }
});

test("O10 Parent deletion versus child edit", () => {
  const table = rich(`<doc><p id="parent">hi</p></doc>`);
  const run = table.get("parent")?.children[0] ?? "";
  const del = ["replica-a", (b: Builder) => void b.deleteNode("parent")] as const;
  const edit = ["replica-b", (b: Builder) => void b.textInsert(run, 0, "!")] as const;
  const deleteFirst = concurrent(table, [del, edit]);
  expect(deleteFirst.outcomes).toEqual(["applied", "rejected"]);
  const editFirst = concurrent(table, [edit, del]);
  expect(editFirst.outcomes).toEqual(["applied", "rejected"]);
  expect(print(editFirst.auth.getTable())).toBe('<doc><p id="parent">!hi</p></doc>');
});

test("O11 Concurrent moves cannot create a cycle", () => {
  const table = rich(
    `<doc><p id="p"><emphasis>a</emphasis></p><p id="q"><emphasis>b</emphasis></p></doc>`,
  );
  const { auth, outcomes } = concurrent(table, [
    ["replica-a", (b) => b.moveNode("q", "p", 0)],
    ["replica-b", (b) => b.moveNode("p", "q", 0)],
  ]);
  expect(outcomes).toEqual(["applied", "rejected"]);
  expect(auth.getTable().get("q")?.parentId).toBe("p");
  expect(auth.getTable().get("p")?.parentId).toBe(ROOT_ID);
});

test("O12 Inline wrap with text replacement", () => {
  const table = rich(`<doc><p id="p1">Term 10 days.</p></doc>`);
  const run = table.get("p1")?.children[0] ?? "";
  const wrap = [
    "replica-a",
    (b: Builder) => void wrapText(b, run, 5, 7, { tag: "emphasis" }),
  ] as const;
  const replace = ["replica-b", (b: Builder) => void b.textReplace(run, 5, 7, "15")] as const;
  for (const order of [
    [wrap, replace],
    [replace, wrap],
  ]) {
    const { auth, outcomes } = concurrent(table, order);
    expect(outcomes).toEqual(["applied", "applied"]);
    expect(print(auth.getTable())).toBe(
      '<doc><p id="p1">Term <emphasis>15</emphasis> days.</p></doc>',
    );
  }
});

test("O13 Split boundary affinity", () => {
  // Recorded affinity: a boundary insertion stays with the left (original) run.
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    let tail = "";
    const requests: [string, (b: Builder) => void][] = [
      ["replica-a", (b) => void (tail = b.split("t", 2))],
      ["replica-b", (b) => b.textInsert("t", 2, "X")],
    ];
    const { auth } = concurrent(
      textDoc("abcd"),
      order.map((i) => requests[i] as (typeof requests)[number]),
    );
    expect(textOf(auth.getTable().get("t"))).toBe("abX");
    expect(textOf(auth.getTable().get(tail))).toBe("cd");
  }
});

test("O14 Temporarily invalid transaction", () => {
  const single = listDoc({ items: ["a"] });
  const { auth, outcomes } = concurrent(
    single,
    [
      [
        "replica-a",
        (b) => b.arrayDelete(ROOT_ID, ["items"], 0).arrayInsert(ROOT_ID, ["items"], 0, ["z"]),
      ],
    ],
    true,
  );
  expect(outcomes).toEqual(["applied"]);
  expect(items(auth.getTable())).toEqual(["z"]);
  expect(auth.getRevision()).toBe(1);
});

test("O15 Invalid final batch is atomic", () => {
  const room = new Room(pairList, { validators: [schemaInvariants(listSchema)] });
  const client = room.join("a", "replica-a");
  client.transact((b) =>
    b
      .set(ROOT_ID, "title", "kept?")
      .arrayDelete(ROOT_ID, ["items"], 1)
      .arrayDelete(ROOT_ID, ["items"], 0),
  );
  room.settle();
  expect(room.authority.getTable().get(ROOT_ID)?.props).toEqual({ items: ["a", "b"] });
  expect(client.getSnapshot().table.get(ROOT_ID)?.props).toEqual({ items: ["a", "b"] });
  expect(client.getStatus().retained.map((r) => r.status)).toEqual(["rejected"]); // local intent retained
});

test("O16 Free agent edit over concurrent work", () => {
  const a = rich(`<doc><p id="p1">Payment in 10 days.</p></doc>`);
  const room = rich(`<doc><p id="p1">Payment in 10 working days.</p></doc>`);
  const agent = rich(`<doc><p id="p1">Payment in 15 days.</p></doc>`);
  const auth = Authority.create(DOC, EPOCH, a);
  auth.submit(
    envelope(
      "replica-h",
      1,
      0,
      diffToChanges(a, fromTable(room, "x", "1").root, { replica: "replica-h", seq: 1 }),
    ),
    { actor: "h" },
  );
  const rebased = rebaseProposal(
    proposeEdit({ table: a, revision: 0 }, fromTable(agent, "x", "1").root, {
      replica: "replica-g",
      seq: 1,
    }),
    auth,
  );
  if (rebased.status !== "rebased") throw new Error(rebased.status);
  auth.submit(envelope("replica-g", 1, rebased.revision, rebased.changes), { actor: "g" });
  expect(print(auth.getTable())).toBe('<doc><p id="p1">Payment in 15 working days.</p></doc>');
});

test("O17 Diff does not invent addition", () => {
  const before = listDoc({ x: 10 });
  const changes: Change[] = diffToChanges(
    before,
    { tag: "list", props: { x: 20 }, content: [] },
    { replica: "replica-a", seq: 1 },
  );
  expect(changes).toMatchObject([{ kind: "set", path: ["x"], before: 10, after: 20 }]);
  expect(changes.some((change) => change.kind === "delta")).toBe(false);
});

test("O18 Effective equality and scalar conflicts", () => {
  const x5 = listDoc({ x: 5 });
  expect(build(x5, "replica-a", 1, (b) => b.set(ROOT_ID, "x", 5))).toEqual([]); // equal effective value: no change
  const same = concurrent(x5, [
    ["replica-a", (b) => b.set(ROOT_ID, "x", 7)],
    ["replica-b", (b) => b.set(ROOT_ID, "x", 7)],
  ]);
  expect(same.outcomes).toEqual(["applied", "alreadySatisfied"]);
  const differ = concurrent(x5, [
    ["replica-a", (b) => b.set(ROOT_ID, "x", 7)],
    ["replica-b", (b) => b.set(ROOT_ID, "x", 9)],
  ]);
  expect(differ.outcomes).toEqual(["applied", "rejected"]);
  // Spelling-only equivalence (omitted, null, explicit default) produces no semantic change.
  const variants = [`<doc><p id="p1">t</p></doc>`, `<doc><p id="p1" opacity="1">t</p></doc>`];
  const [first, second] = variants.map(rich);
  if (first === undefined || second === undefined) throw new Error("fixture");
  expect(
    diffToChanges(first, fromTable(second, "x", "1").root, { replica: "replica-a", seq: 1 }),
  ).toEqual([]);
});

test("O19 Merge and range relocation with text edit", () => {
  const base = textDoc("foobar");
  let tail = "";
  const split = build(base, "replica-a", 1, (b) => void (tail = b.split("t", 3)));
  const auth = Authority.create(DOC, EPOCH, base);
  auth.submit(envelope("replica-a", 1, 0, split), { actor: "a" });
  const splitTable = auth.getTable();
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const requests: [string, (b: Builder) => void][] = [
      ["replica-a", (b) => b.merge("t")],
      ["replica-b", (b) => b.textReplace(tail, 1, 2, "X")],
    ];
    const { auth: result, outcomes } = concurrent(
      splitTable,
      order.map((i) => requests[i] as (typeof requests)[number]),
    );
    expect(outcomes).toEqual(["applied", "applied"]);
    expect(textOf(result.getTable().get("t"))).toBe("foobXr");
    expect(result.getTable().has(tail)).toBe(false);
  }
});
