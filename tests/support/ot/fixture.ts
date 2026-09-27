import { ChangeBuilder } from "../../../src/core/builder.ts";
import type { Change, ChangeKind } from "../../../src/core/change.ts";
import type { Table } from "../../../src/core/table.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "../../../src/core/table.ts";
import { tableFrom } from "../gen.ts";

/**
 * The pair-matrix base document. Paragraph p1 holds two adjacent text runs
 * (so split/merge interact with insertions between them) and an anonymous
 * inline node; the root carries a list with duplicate values, nested
 * object props, and numbers; s1 nests p3 to give ancestor/descendant pairs.
 *
 *   $root doc {items:["a","b","a",{"k":1}], meta:{x:1,y:2}, n:5, title:"t"}
 *   ├─ p1 p {n:1}      [r1 "abcdef", r2 "ij", e1 em [r3 "gh"]]
 *   ├─ p2 p            [r4 "klm", r6 "pq"]
 *   └─ s1 sec          [p3 p [r5 "no"]]
 */
export function pairBase(): Table {
  return tableFrom([
    makeRow(
      ROOT_ID,
      "doc",
      { items: ["a", "b", "a", { k: 1 }], meta: { x: 1, y: 2 }, n: 5, title: "t" },
      null,
      ["p1", "p2", "s1"],
      false,
    ),
    makeRow("p1", "p", { n: 1 }, ROOT_ID, ["r1", "r2", "e1"], true),
    makeRow("r1", TEXT_TAG, { value: "abcdef" }, "p1", [], false),
    makeRow("r2", TEXT_TAG, { value: "ij" }, "p1", [], false),
    makeRow("e1", "em", {}, "p1", ["r3"], false),
    makeRow("r3", TEXT_TAG, { value: "gh" }, "e1", [], false),
    makeRow("p2", "p", {}, ROOT_ID, ["r4", "r6"], true),
    makeRow("r4", TEXT_TAG, { value: "klm" }, "p2", [], false),
    makeRow("r6", TEXT_TAG, { value: "pq" }, "p2", [], false),
    makeRow("s1", "sec", {}, ROOT_ID, ["p3"], true),
    makeRow("p3", "p", {}, "s1", ["r5"], true),
    makeRow("r5", TEXT_TAG, { value: "no" }, "p3", [], false),
  ]);
}

/** One positioned primitive: its kind, a geometry label, and how to author it. */
export interface Instance {
  readonly kind: ChangeKind;
  readonly label: string;
  readonly build: (b: ChangeBuilder) => void;
}

const I = (kind: ChangeKind, label: string, build: (b: ChangeBuilder) => void): Instance => ({
  kind,
  label,
  build,
});

/**
 * Instances chosen to reach the boundary geometries of every kind: start,
 * inside, end, and whole ranges; same/sibling/nested/ancestor targets; equal
 * duplicate occurrences; moves in both directions and between parents;
 * split/merge boundaries; no-op-equivalent pairs arise from equal instances.
 */
export const INSTANCES: readonly Instance[] = [
  I("set", "root title", (b) => b.set(ROOT_ID, "title", "T2")),
  I("set", "root title same value", (b) => b.set(ROOT_ID, "title", "T2")),
  I("set", "root title other value", (b) => b.set(ROOT_ID, "title", "T3")),
  I("set", "root title removed", (b) => b.set(ROOT_ID, "title", undefined)),
  I("set", "nested meta.x", (b) => b.set(ROOT_ID, ["meta", "x"], 9)),
  I("set", "whole meta", (b) => b.set(ROOT_ID, "meta", { x: 0 })),
  I("set", "inside items[3].k", (b) => b.set(ROOT_ID, ["items", 3, "k"], 2)),
  I("set", "whole items", (b) => b.set(ROOT_ID, "items", [])),
  I("set", "p1 n", (b) => b.set("p1", "n", 7)),
  I("set", "p3 flag (nested node)", (b) => b.set("p3", "flag", true)),
  I("delta", "root n", (b) => b.delta(ROOT_ID, "n", 2)),
  I("delta", "root n again", (b) => b.delta(ROOT_ID, "n", 3)),
  I("delta", "p1 n", (b) => b.delta("p1", "n", -1)),
  I("delta", "meta.x", (b) => b.delta(ROOT_ID, ["meta", "x"], 1)),
  I("arrayInsert", "items at 0", (b) => b.arrayInsert(ROOT_ID, ["items"], 0, ["z"])),
  I("arrayInsert", "items at 1", (b) => b.arrayInsert(ROOT_ID, ["items"], 1, ["z"])),
  I("arrayInsert", "items at 2 (duplicate value)", (b) =>
    b.arrayInsert(ROOT_ID, ["items"], 2, ["a"]),
  ),
  I("arrayInsert", "items at end", (b) => b.arrayInsert(ROOT_ID, ["items"], 4, ["y", "w"])),
  I("arrayDelete", "items[0] (first a)", (b) => b.arrayDelete(ROOT_ID, ["items"], 0)),
  I("arrayDelete", "items[2] (second a)", (b) => b.arrayDelete(ROOT_ID, ["items"], 2)),
  I("arrayDelete", "items[1..3)", (b) => b.arrayDelete(ROOT_ID, ["items"], 1, 2)),
  I("arrayDelete", "items[3] object", (b) => b.arrayDelete(ROOT_ID, ["items"], 3)),
  I("arrayMove", "items 0 to end", (b) => b.arrayMove(ROOT_ID, ["items"], 0, 4)),
  I("arrayMove", "items 3 to start", (b) => b.arrayMove(ROOT_ID, ["items"], 3, 0)),
  I("arrayMove", "items 2 to 1", (b) => b.arrayMove(ROOT_ID, ["items"], 2, 1)),
  I("textInsert", "r1 start", (b) => b.textInsert("r1", 0, "X")),
  I("textInsert", "r1 inside", (b) => b.textInsert("r1", 3, "X")),
  I("textInsert", "r1 inside other", (b) => b.textInsert("r1", 3, "Y")),
  I("textInsert", "r1 end", (b) => b.textInsert("r1", 6, "X")),
  I("textInsert", "r2 start", (b) => b.textInsert("r2", 0, "Q")),
  I("textInsert", "r3 nested", (b) => b.textInsert("r3", 1, "N")),
  I("textInsert", "r5 in section", (b) => b.textInsert("r5", 2, "S")),
  I("textInsert", "r6 end", (b) => b.textInsert("r6", 2, "R")),
  I("textInsert", "r1 astral", (b) => b.textInsert("r1", 2, "😀")),
  I("textDelete", "r1 [0,2)", (b) => b.textDelete("r1", 0, 2)),
  I("textDelete", "r1 [1,4)", (b) => b.textDelete("r1", 1, 3)),
  I("textDelete", "r1 [2,3)", (b) => b.textDelete("r1", 2, 1)),
  I("textDelete", "r1 [3,6)", (b) => b.textDelete("r1", 3, 3)),
  I("textDelete", "r1 all", (b) => b.textDelete("r1", 0, 6)),
  I("textDelete", "r2 all", (b) => b.textDelete("r2", 0, 2)),
  I("split", "r1 at 3", (b) => void b.split("r1", 3)),
  I("split", "r1 at 0", (b) => void b.split("r1", 0)),
  I("split", "r1 at end", (b) => void b.split("r1", 6)),
  I("split", "r3 nested", (b) => void b.split("r3", 1)),
  I("merge", "r1+r2", (b) => void b.merge("r1")),
  I("merge", "r4+r6", (b) => void b.merge("r4")),
  I("nodeInsert", "root at 0", (b) => void b.insertNode(ROOT_ID, 0, { tag: "p", id: "n1" })),
  I("nodeInsert", "root at 1", (b) => void b.insertNode(ROOT_ID, 1, { tag: "p", id: "n2" })),
  I("nodeInsert", "root at end", (b) => void b.insertNode(ROOT_ID, 3, { tag: "p", id: "n3" })),
  I("nodeInsert", "p1 between r1 and r2", (b) => void b.insertNode("p1", 1, { tag: "em" })),
  I("nodeInsert", "p1 at 0", (b) => void b.insertNode("p1", 0, "lead")),
  I("nodeInsert", "p1 at end", (b) => void b.insertNode("p1", 3, "tail")),
  I("nodeInsert", "inside e1", (b) => void b.insertNode("e1", 1, "in")),
  I("nodeInsert", "into s1", (b) => void b.insertNode("s1", 0, { tag: "p", id: "n4" })),
  I("nodeDelete", "p2", (b) => b.deleteNode("p2")),
  I("nodeDelete", "e1 (anonymous)", (b) => b.deleteNode("e1")),
  I("nodeDelete", "r2 (text run)", (b) => b.deleteNode("r2")),
  I("nodeDelete", "p3 (nested)", (b) => b.deleteNode("p3")),
  I("nodeDelete", "s1 (ancestor)", (b) => b.deleteNode("s1")),
  I("nodeDelete", "p1 (with runs)", (b) => b.deleteNode("p1")),
  I("nodeMove", "p2 into s1", (b) => b.moveNode("p2", "s1", 0)),
  I("nodeMove", "p3 to root start", (b) => b.moveNode("p3", ROOT_ID, 0)),
  I("nodeMove", "p1 to root end", (b) => b.moveNode("p1", ROOT_ID, 3)),
  I("nodeMove", "p2 to root start", (b) => b.moveNode("p2", ROOT_ID, 0)),
  I("nodeMove", "e1 into p2", (b) => b.moveNode("e1", "p2", 1)),
  I("nodeMove", "r2 into p2", (b) => b.moveNode("r2", "p2", 0)),
  I("nodeMove", "s1 into p2 (then cycle risk)", (b) => b.moveNode("s1", "p2", 1)),
  I("nodeMove", "p2 into p3", (b) => b.moveNode("p2", "p3", 0)),
  I("setTag", "p1 to h", (b) => b.setTag("p1", "h")),
  I("setTag", "p1 to h again", (b) => b.setTag("p1", "h")),
  I("setTag", "p1 to q", (b) => b.setTag("p1", "q")),
  I("setTag", "p3 nested", (b) => b.setTag("p3", "h")),
  I("setTag", "e1 anonymous", (b) => b.setTag("e1", "strong")),
];

/** Author one instance as a single-transaction record by `replica`. */
export function author(instance: Instance, base: Table, replica: string, seq = 1): Change[] {
  const builder = new ChangeBuilder(base, { replica, seq });
  instance.build(builder);
  return [...builder.changes];
}
