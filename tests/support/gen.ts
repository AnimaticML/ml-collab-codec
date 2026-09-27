import { isJsonArray } from "../../src/core/types.ts";
import type { Change } from "../../src/core/change.ts";
import { ChangeBuilder } from "../../src/core/builder.ts";
import type { Table, TableNode } from "../../src/core/table.ts";
import { makeRow, ROOT_ID, TEXT_TAG, textOf } from "../../src/core/table.ts";
import type { JsonObject, JsonValue } from "../../src/core/types.ts";
import type { Rng } from "./random.ts";

/** Canonical comparable form of a table (row order independent). */
export function canonicalTable(table: Table): string {
  const rows = [...table.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify(rows);
}

export function tableFrom(rows: readonly TableNode[]): Table {
  return new Map(rows.map((r) => [r.id, r]));
}

const WORDS = ["ab", "cd", "xyz", "Ёж", "😀e", "a"];

/** A random small document: paragraphs of text runs and inline nodes, plus array/number props. */
export function randomTable(r: Rng): Table {
  const rows: TableNode[] = [];
  const paragraphs: string[] = [];
  for (let p = 0; p < 2 + r.int(2); p += 1) {
    const pid = `p${p}`;
    const kids: string[] = [];
    for (let k = 0; k < 1 + r.int(3); k += 1) {
      const kid = `${pid}t${k}`;
      if (k % 2 === 1 && r.chance(0.4)) {
        const inner = `${kid}i`;
        rows.push(makeRow(inner, TEXT_TAG, { value: r.pick(WORDS) }, kid, [], false));
        rows.push(makeRow(kid, "em", {}, pid, [inner], false));
      } else {
        rows.push(makeRow(kid, TEXT_TAG, { value: r.pick(WORDS) + r.pick(WORDS) }, pid, [], false));
      }
      kids.push(kid);
    }
    rows.push(
      makeRow(
        pid,
        "p",
        { n: r.int(5), tags: ["a", "a", "b"].slice(0, 1 + r.int(3)) },
        ROOT_ID,
        kids,
        true,
      ),
    );
    paragraphs.push(pid);
  }
  const items: JsonValue[] = [
    { name: "x", tags: ["q"] },
    "a",
    "a",
    { name: "x", tags: ["q"] },
  ].slice(0, 2 + r.int(3));
  rows.push(makeRow(ROOT_ID, "doc", { items, count: 10, title: "t" }, null, paragraphs, false));
  return tableFrom(rows);
}

function textRuns(table: Table): TableNode[] {
  return [...table.values()].filter((row) => row.tag === TEXT_TAG);
}

function containers(table: Table): TableNode[] {
  return [...table.values()].filter((row) => row.tag !== TEXT_TAG);
}

function arrayTargets(table: Table): { node: string; path: (string | number)[]; length: number }[] {
  const out: { node: string; path: (string | number)[]; length: number }[] = [];
  for (const row of containers(table)) {
    for (const [key, value] of Object.entries(row.props)) {
      if (!Array.isArray(value)) continue;
      out.push({ node: row.id, path: [key], length: value.length });
      value.forEach((item, i) => {
        if (
          typeof item === "object" &&
          item !== null &&
          !Array.isArray(item) &&
          isJsonArray((item as JsonObject)["tags"])
        )
          out.push({
            node: row.id,
            path: [key, i, "tags"],
            length: ((item as JsonObject)["tags"] as readonly JsonValue[]).length,
          });
      });
    }
  }
  return out;
}

type Generator = (b: ChangeBuilder, table: Table, r: Rng) => boolean;

const generators: Generator[] = [
  (b, t, r) => {
    const runs = textRuns(t);
    if (runs.length === 0) return false;
    const run = r.pick(runs);
    b.textInsert(run.id, r.int([...textOf(run)].length + 1), r.pick(["X", "YZ", "Ω"]));
    return true;
  },
  (b, t, r) => {
    const runs = textRuns(t);
    if (runs.length === 0) return false;
    const run = r.pick(runs);
    const len = [...textOf(run)].length;
    if (len === 0) return false;
    const start = r.int(len);
    b.textDelete(run.id, start, 1 + r.int(len - start));
    return true;
  },
  (b, t, r) => {
    const runs = textRuns(t);
    if (runs.length === 0) return false;
    const run = r.pick(runs);
    b.split(run.id, r.int([...textOf(run)].length + 1));
    return true;
  },
  (b, t, r) => {
    const runs = textRuns(t);
    if (runs.length === 0) return false;
    const run = r.pick(runs);
    const parent = t.get(run.parentId ?? "");
    const next = parent?.children[parent.children.indexOf(run.id) + 1];
    if (next === undefined || t.get(next)?.tag !== TEXT_TAG) return false;
    b.merge(run.id);
    return true;
  },
  (b, t, r) => {
    const targets = arrayTargets(t);
    if (targets.length === 0) return false;
    const target = r.pick(targets);
    b.arrayInsert(target.node, target.path, r.int(target.length + 1), [r.pick(["a", "N", "b"])]);
    return true;
  },
  (b, t, r) => {
    const targets = arrayTargets(t);
    if (targets.length === 0) return false;
    const target = r.pick(targets);
    if (target.length === 0) return false;
    const start = r.int(target.length);
    b.arrayDelete(target.node, target.path, start, 1 + r.int(Math.min(2, target.length - start)));
    return true;
  },
  (b, t, r) => {
    const targets = arrayTargets(t);
    if (targets.length === 0) return false;
    const target = r.pick(targets);
    if (target.length < 2) return false;
    const from = r.int(target.length);
    const gap = r.int(target.length + 1);
    if (gap === from || gap === from + 1) return false;
    b.arrayMove(target.node, target.path, from, gap);
    return true;
  },
  (b, t, r) => {
    const row = r.pick(containers(t));
    if (r.chance(0.5)) b.set(row.id, "title", r.pick(["u", "v", undefined]));
    else if (typeof row.props["n"] === "number") b.delta(row.id, "n", r.pick([1, 2, -1]));
    else return false;
    return true;
  },
  (b, t, r) => {
    const items = t.get(ROOT_ID)?.props["items"];
    if (!Array.isArray(items)) return false;
    const objects = items.flatMap((item, i) =>
      typeof item === "object" && item !== null && !Array.isArray(item) ? [i] : [],
    );
    if (objects.length === 0) return false;
    b.set(ROOT_ID, ["items", r.pick(objects), "name"], r.pick(["y", "z"]));
    return true;
  },
  (b, t, r) => {
    const parent = r.pick(containers(t));
    const spec = r.chance(0.5) ? r.pick(["N", "new"]) : { tag: "em", children: ["in"] };
    b.insertNode(parent.id, r.int(parent.children.length + 1), spec);
    return true;
  },
  (b, t, r) => {
    const victims = [...t.values()].filter((row) => row.id !== ROOT_ID);
    if (victims.length === 0) return false;
    b.deleteNode(r.pick(victims).id);
    return true;
  },
  (b, t, r) => {
    const movable = [...t.values()].filter((row) => row.id !== ROOT_ID);
    if (movable.length === 0) return false;
    const node = r.pick(movable);
    const targets = containers(t).filter(
      (row) => row.id !== node.id && !isWithin(t, row.id, node.id),
    );
    if (targets.length === 0) return false;
    const to = r.pick(targets);
    b.moveNode(node.id, to.id, r.int(to.children.length + 1));
    return true;
  },
  (b, t, r) => {
    const nodes = containers(t).filter((row) => row.id !== ROOT_ID);
    if (nodes.length === 0) return false;
    const node = r.pick(nodes);
    const tag = r.pick(["p", "h", "em", "q"].filter((candidate) => candidate !== node.tag));
    b.setTag(node.id, tag);
    return true;
  },
];

function isWithin(table: Table, id: string, ancestor: string): boolean {
  for (
    let cursor: string | null = id;
    cursor !== null;
    cursor = table.get(cursor)?.parentId ?? null
  )
    if (cursor === ancestor) return true;
  return false;
}

/** Apply up to `steps` random commands to an existing builder (e.g. inside a client transaction). */
export function randomCommands(builder: ChangeBuilder, r: Rng, steps: number): void {
  for (let attempt = 0; builder.changes.length < steps && attempt < 40; attempt += 1) {
    r.pick(generators)(builder, builder.current(), r);
  }
}

/** One random change (1..maxSteps sequential primitives) authored by `replica` in state `table`. */
export function randomChange(
  table: Table,
  r: Rng,
  replica: string,
  seq: number,
  maxSteps = 1,
): Change[] {
  const builder = new ChangeBuilder(table, { replica, seq });
  randomCommands(builder, r, 1 + r.int(maxSteps));
  return [...builder.changes];
}
