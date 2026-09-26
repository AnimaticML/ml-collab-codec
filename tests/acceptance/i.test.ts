import { expect, test } from "bun:test";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { findNodeById } from "../../src/core/address.ts";
import { toTable, fromTable, createAllocator, children, textOf } from "../../src/core/table.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { diffToChanges } from "../../src/core/diff.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import { mapAnchor } from "../../src/core/anchors.ts";
import { Authority } from "../../src/core/authority.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";

function parsed(source: string) {
  const result = parseDocument(source, richTextSchema);
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

test("I01 Addressable roles, not all objects", () => {
  const source = `<doc><p id="p1">plain text with <emphasis>inline</emphasis> content</p></doc>`;
  const model = parsed(source);
  expect(findNodeById(model.root, "p1")).toBeDefined();
  // Emphasis and the plain text runs carry no id -- they are relatively addressed, not stable objects.
  const p = findNodeById(model.root, "p1")?.node;
  const emphasis = p?.content?.find((item) => typeof item !== "string");
  expect(emphasis && typeof emphasis !== "string" ? emphasis.id : "none").toBeUndefined();
  // Internal handles exist in the operational table but never surface as persisted ids.
  const table = toTable(model, createAllocator());
  expect([...table.values()].filter((row) => row.persisted).map((row) => row.id)).toEqual(["p1"]);
  expect(JSON.stringify(fromTable(table, richTextSchema.id, richTextSchema.version))).not.toContain(
    '"t0"',
  );
  // Reparsing (parse/print churn check) must not invent or move stable IDs.
  const reparsed = parseDocument(serializeDocument(model, richTextSchema), richTextSchema);
  expect(reparsed.ok && findNodeById(reparsed.value.root, "p1")?.node.id).toBe("p1");
});

test("I01 Persisted ids that look like internal handles do not collide", () => {
  // Regression (found while benchmarking): a table with id "t1" collided with the internal
  // handle "t1" of an anonymous text run, producing a cyclic table.
  const model = parsed(`<doc><p id="t1">a <emphasis>b</emphasis></p><p id="t0">c</p></doc>`);
  const table = toTable(model, createAllocator());
  expect(table.get("t1")?.tag).toBe("p");
  expect(fromTable(table, richTextSchema.id, richTextSchema.version)).toEqual(model);
  const duplicate = {
    ...model,
    root: {
      ...model.root,
      content: [
        { tag: "p", id: "x", props: {} },
        { tag: "p", id: "x", props: {} },
      ],
    },
  };
  expect(() => toTable(duplicate, createAllocator())).toThrow("duplicate id");
});

test("I02 Move, copy, split, and merge identity", () => {
  const table = toTable(
    parsed(`<doc><p id="p1">alpha</p><p id="p2">beta</p></doc>`),
    createAllocator(),
  );
  // Move preserves the node's own id.
  const moved = applyChanges(
    table,
    build(table, "replica-a", 1, (b) => b.moveNode("p2", "$root", 0)),
  );
  expect(moved.get("$root")?.children).toEqual(["p2", "p1"]);
  expect(moved.get("p2")?.id).toBe("p2");
  // Copy allocates a distinct persisted id; a colliding id is refused, never silently reused.
  const copy = build(
    moved,
    "replica-a",
    2,
    (b) =>
      void b.insertNode("$root", 2, { tag: "p", id: "p1-copy", props: {}, children: ["alpha"] }),
  );
  const copied = applyChanges(moved, copy);
  expect(copied.has("p1") && copied.has("p1-copy")).toBe(true);
  expect(() =>
    build(
      copied,
      "replica-a",
      3,
      (b) => void b.insertNode("$root", 0, { tag: "p", id: "p1", props: {} }),
    ),
  ).toThrow("already in use");
  // Split keeps the original run id for the head and creates a handle for the tail; merge removes it again.
  const run = table.get("p1")?.children[0] ?? "";
  let tail = "";
  const split = applyChanges(
    table,
    build(table, "replica-a", 4, (b) => void (tail = b.split(run, 2))),
  );
  expect([textOf(split.get(run)), textOf(split.get(tail))]).toEqual(["al", "pha"]);
  const merged = applyChanges(
    split,
    build(split, "replica-a", 5, (b) => b.merge(run)),
  );
  expect(textOf(merged.get(run))).toBe("alpha");
  expect(merged.has(tail)).toBe(false);
});

test("I03 Base-relative Unicode addresses", () => {
  const table = toTable(parsed(`<doc><p id="p1">caf&amp;é АБ 😀</p></doc>`), createAllocator());
  const run = table.get("p1")?.children[0] ?? "";
  expect([...textOf(table.get(run))]).toHaveLength(10); // decoded content in code points: "&" is one unit
  // A stale address formed at the base maps through a later insertion instead of reusing its number.
  const auth = Authority.create(DOC, EPOCH, table);
  auth.submit(
    envelope(
      "replica-a",
      1,
      0,
      build(table, "replica-a", 1, (b) => b.textInsert(run, 0, "Ё")),
    ),
    { actor: "a" },
  );
  const emoji = { kind: "point" as const, node: run, offset: 9, affinity: "after" as const };
  const mapped = mapAnchor(emoji, auth.transitionsSince(0)?.flatMap((t) => t.changes) ?? []);
  expect(mapped).toMatchObject({ status: "mapped", anchor: { offset: 10 } });
  expect([...textOf(auth.getTable().get(run))][10]).toBe("😀");
  // A request based on revision 0 addressing the emoji edits the emoji, not a shifted neighbour.
  auth.submit(
    envelope(
      "replica-b",
      1,
      0,
      build(table, "replica-b", 1, (b) => b.textReplace(run, 9, 10, "☕")),
    ),
    { actor: "b" },
  );
  expect(textOf(auth.getTable().get(run))).toBe("Ёcaf&é АБ ☕");
});

test("I04 Reference and replacement boundaries", () => {
  const table = toTable(
    parsed(`<doc><p id="parent">outer <emphasis>inner</emphasis></p></doc>`),
    createAllocator(),
  );
  const emphasis = children(table, "parent").find((row) => row.tag === "emphasis");
  expect(emphasis).toBeDefined();
  // A child edit and a parent-property edit are independent; a parent deletion is not.
  const auth = Authority.create(DOC, EPOCH, table);
  const inner = emphasis?.children[0] ?? "";
  const childEdit = build(table, "replica-a", 1, (b) => b.textInsert(inner, 0, "!"));
  const parentProp = build(table, "replica-b", 1, (b) => b.set("parent", "opacity", 0.5));
  const deleteParent = build(table, "replica-c", 1, (b) => b.deleteNode("parent"));
  auth.submit(envelope("replica-a", 1, 0, childEdit), { actor: "a" });
  expect(auth.submit(envelope("replica-b", 1, 0, parentProp), { actor: "b" })).toMatchObject({
    receipt: { outcome: "applied" },
  });
  expect(auth.submit(envelope("replica-c", 1, 0, deleteParent), { actor: "c" })).toMatchObject({
    receipt: { outcome: "rejected" },
  });
  // Whole replacement (via diff) stays a whole replacement: it does not decompose into a child-preserving edit.
  const replacement = parsed(`<doc><p id="parent">completely different</p></doc>`);
  const changes = diffToChanges(table, replacement.root, { replica: "replica-d", seq: 1 });
  expect(changes.some((change) => change.kind === "nodeDelete")).toBe(true);
  const finalDoc = fromTable(
    applyChanges(table, changes),
    richTextSchema.id,
    richTextSchema.version,
  );
  expect(serializeDocument(finalDoc, richTextSchema)).toBe(
    '<doc><p id="parent">completely different</p></doc>',
  );
});
