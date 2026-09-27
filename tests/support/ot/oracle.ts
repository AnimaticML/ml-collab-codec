import type { Change } from "../../../src/core/change.ts";
import type { Table } from "../../../src/core/table.ts";
import { TEXT_TAG, textOf } from "../../../src/core/table.ts";
import type { Edit, Token } from "./model.ts";
import { getIn, mergeSequence, setIn } from "./model.ts";

/**
 * Expected outcome of two concurrent single primitives from SPEC §8.2 and
 * §18.4, derived from the records and the base document only (never from
 * the transform under test).
 */
export type Expectation = "compatible" | "conflict" | "refusal";

type Path = readonly (string | number)[];

function subtree(base: Table, id: string, into: Set<string> = new Set()): Set<string> {
  into.add(id);
  for (const child of base.get(id)?.children ?? []) subtree(base, child, into);
  return into;
}

function requires(c: Change): string[] {
  switch (c.kind) {
    case "split":
      return [c.node, c.parent];
    case "merge":
      return [c.node, c.other, c.parent];
    case "nodeInsert":
    case "nodeDelete":
      return [c.parent];
    case "nodeMove":
      return [c.node, c.fromParent, c.toParent];
    default:
      return [c.node];
  }
}

function destroys(c: Change, base: Table): Set<string> {
  if (c.kind === "nodeDelete") return subtree(base, c.subtree.id);
  if (c.kind === "merge") return new Set([c.other]);
  return new Set();
}

/** The property path a prop-level primitive writes (for array operations: the array itself). */
function propPath(c: Change): Path | undefined {
  return "path" in c ? c.path : undefined;
}

const isPrefix = (p: Path, q: Path): boolean =>
  p.length <= q.length && p.every((s, i) => q[i] === s);
const strictPrefix = (p: Path, q: Path): boolean => p.length < q.length && isPrefix(p, q);
const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);

function propConflict(a: Change, b: Change): boolean {
  const pa = propPath(a);
  const pb = propPath(b);
  if (pa === undefined || pb === undefined || a.kind === "setTag" || b.kind === "setTag")
    return false;
  if (!("node" in a) || !("node" in b) || a.node !== b.node) return false;
  const arrayOp = (c: Change): boolean => c.kind.startsWith("array");
  if (a.kind === "set" && b.kind === "set" && same(pa, pb)) return !same(a.after, b.after);
  if (same(pa, pb) && [a.kind, b.kind].includes("set") && [a.kind, b.kind].includes("delta"))
    return true;
  for (const [s, o] of [
    [a, b],
    [b, a],
  ] as const) {
    const ps = propPath(s) as Path;
    const po = propPath(o) as Path;
    if (s.kind !== "set") continue;
    if (arrayOp(o) ? isPrefix(ps, po) : strictPrefix(ps, po) || strictPrefix(po, ps)) return true;
  }
  // Removal (or move) of an occurrence that the other change edits or moves.
  for (const [s, o] of [
    [a, b],
    [b, a],
  ] as const) {
    if (s.kind !== "arrayDelete") continue;
    const po = propPath(o) as Path;
    const removed = (i: number): boolean => i >= s.index && i < s.index + s.values.length;
    if (o.kind === "arrayMove" && same(o.path, s.path) && removed(o.from)) return true;
    if (strictPrefix(s.path, po) && removed(Number(po[s.path.length]))) return true;
  }
  if (a.kind === "arrayMove" && b.kind === "arrayMove" && same(a.path, b.path) && a.from === b.from)
    return landing(a.from, a.gap) !== landing(b.from, b.gap);
  return false;
}

const landing = (from: number, gap: number): number => (gap > from ? gap - 1 : gap);

function structureConflict(a: Change, b: Change): boolean {
  for (const [s, o] of [
    [a, b],
    [b, a],
  ] as const) {
    if (s.kind === "split" || s.kind === "merge") {
      const runs = s.kind === "merge" ? [s.node, s.other] : [s.node];
      if (o.kind === "nodeMove" && runs.includes(o.node)) return true;
      if (s.kind === "merge") {
        const gapBetween = s.index + 1;
        if (o.kind === "nodeInsert" && o.parent === s.parent && o.index === gapBetween) return true;
        if (o.kind === "nodeMove" && o.toParent === s.parent && o.gap === gapBetween) return true;
      }
    }
  }
  if (a.kind === "nodeMove" && b.kind === "nodeMove" && a.node === b.node) {
    const land = (m: typeof a): number =>
      m.fromParent === m.toParent ? landing(m.fromIndex, m.gap) : m.gap;
    return a.toParent !== b.toParent || land(a) !== land(b);
  }
  if (a.kind === "setTag" && b.kind === "setTag" && a.node === b.node) return a.after !== b.after;
  return false;
}

/** Parent links after both moves; a cycle is refused when the candidate is applied. */
function movesFormCycle(a: Change, b: Change, base: Table): boolean {
  if (a.kind !== "nodeMove" || b.kind !== "nodeMove") return false;
  const parent = (id: string): string | null =>
    id === a.node ? a.toParent : id === b.node ? b.toParent : (base.get(id)?.parentId ?? null);
  for (const start of [a.node, b.node]) {
    const seen = new Set<string>();
    for (let cursor: string | null = parent(start); cursor !== null; cursor = parent(cursor)) {
      if (cursor === start || seen.has(cursor)) return true;
      seen.add(cursor);
    }
  }
  return false;
}

const IDEMPOTENT = new Set([
  "set",
  "setTag",
  "textDelete",
  "arrayDelete",
  "nodeDelete",
  "arrayMove",
  "nodeMove",
  "merge",
]);

/** Equal record content ignoring origins. */
function sameRecord(a: Change, b: Change): boolean {
  const { origin: _a, ...x } = a;
  const { origin: _b, ...y } = b;
  return same(x, y);
}

/**
 * The same idempotent effect authored twice: already satisfied by the first
 * (SPEC §18.4: equal sets and equal deletions become no-ops). Insertions and
 * deltas are separate contributions and both apply.
 */
export function sameEffect(a: Change, b: Change): boolean {
  return IDEMPOTENT.has(a.kind) && sameRecord(a, b);
}

/**
 * Edits addressed to a concurrently absorbed run (text edits, a split, or a
 * further merge of that run with its next neighbour) follow its text into
 * the surviving run.
 */
function followsMerge(x: Change, y: Change): boolean {
  return (
    y.kind === "merge" &&
    (x.kind === "textInsert" ||
      x.kind === "textDelete" ||
      x.kind === "split" ||
      x.kind === "merge") &&
    x.node === y.other
  );
}

export function predict(a: Change, b: Change, base: Table): Expectation {
  if (sameEffect(a, b)) return "compatible";
  // Two creations of one persisted id collide at apply time (an identity invariant).
  if (a.kind === "nodeInsert" && b.kind === "nodeInsert" && a.subtree.persisted && sameRecord(a, b))
    return "refusal";
  const equalDeletion =
    a.kind === "nodeDelete" && b.kind === "nodeDelete" && a.subtree.id === b.subtree.id;
  if (!equalDeletion) {
    const hit = (x: Change, y: Change): boolean =>
      !followsMerge(x, y) && requires(x).some((id) => destroys(y, base).has(id));
    if (hit(a, b) || hit(b, a)) return "conflict";
    if (a.kind === "nodeDelete" && b.kind === "nodeDelete") {
      const ours = subtree(base, a.subtree.id);
      if ([...subtree(base, b.subtree.id)].some((id) => ours.has(id))) return "conflict";
    }
  }
  if (propConflict(a, b) || structureConflict(a, b)) return "conflict";
  if (movesFormCycle(a, b, base)) return "refusal";
  return "compatible";
}

/** Group of adjacent text runs (in base) containing `run`, identified by its first run. */
function groupOf(base: Table, run: string): string[] {
  const parent = base.get(base.get(run)?.parentId ?? "");
  if (parent === undefined) return [run];
  const kids = parent.children;
  let start = kids.indexOf(run);
  let end = start;
  const isText = (id: string | undefined): boolean => base.get(id ?? "")?.tag === TEXT_TAG;
  while (start > 0 && isText(kids[start - 1])) start -= 1;
  while (end < kids.length - 1 && isText(kids[end + 1])) end += 1;
  return kids.slice(start, end + 1);
}

/** Sequences a primitive touches: `text|<first run>`, `children|<parent>`, `array|<node>|<path>`. */
export function sequences(c: Change, base: Table): string[] {
  const text = (run: string): string => `text|${groupOf(base, run)[0] ?? run}`;
  switch (c.kind) {
    case "textInsert":
    case "textDelete":
      return [text(c.node)];
    case "split":
    case "merge":
      return [text(c.node), `children|${c.parent}`];
    case "nodeInsert":
      return [`children|${c.parent}`];
    case "nodeDelete":
      return [
        `children|${c.parent}`,
        ...(base.get(c.subtree.id)?.tag === TEXT_TAG ? [text(c.subtree.id)] : []),
      ];
    case "nodeMove":
      return [`children|${c.fromParent}`, `children|${c.toParent}`];
    case "setTag":
      return [];
    default:
      return arrayOf(c, base);
  }
}

function arrayOf(c: Change, base: Table): string[] {
  const path = propPath(c) as Path;
  if (c.kind.startsWith("array"))
    return [`array|${"node" in c ? c.node : ""}|${JSON.stringify(path)}`];
  const props = base.get("node" in c ? c.node : "")?.props;
  for (let i = 0; i < path.length - 1; i += 1)
    if (Array.isArray(getIn(props, path.slice(0, i + 1))) && typeof path[i + 1] === "number")
      return [`array|${"node" in c ? c.node : ""}|${JSON.stringify(path.slice(0, i + 1))}`];
  return [];
}

const originOf = (c: Change) => c.origin;
const codePoints = (s: string): string[] => [...s];

/** Expected content of one touched sequence after both primitives, from the identity model. */
export function expectedSequence(seq: string, changes: readonly Change[], base: Table): unknown {
  const [kind, id, path] = seq.split("|") as [string, string, string | undefined];
  if (kind === "children") return childList(id, changes, base);
  if (kind === "array") return arrayList(id, JSON.parse(path ?? "[]") as Path, changes, base);
  return textGroup(id, changes, base);
}

function childList(parent: string, changes: readonly Change[], base: Table): string[] {
  const kids = base.get(parent)?.children ?? [];
  const tokens: Token[] = kids.map((key) => ({ key, value: key }));
  const edits: Edit[] = [];
  for (const c of changes) {
    const token = (key: string): Token[] => [{ key, value: key }];
    if (c.kind === "nodeInsert" && c.parent === parent)
      edits.push({
        t: "ins",
        gap: c.index,
        tokens: token(c.subtree.id),
        origin: originOf(c),
        rank: 1,
      });
    if (c.kind === "nodeDelete" && c.parent === parent) edits.push({ t: "del", index: c.index });
    if (c.kind === "nodeMove" && c.fromParent === parent)
      edits.push({ t: "del", index: c.fromIndex });
    if (c.kind === "nodeMove" && c.toParent === parent)
      edits.push({ t: "ins", gap: c.gap, tokens: token(c.node), origin: originOf(c), rank: 1 });
    if (c.kind === "split" && c.parent === parent)
      edits.push({
        t: "ins",
        gap: c.index + 1,
        tokens: token(c.other),
        origin: originOf(c),
        rank: 0,
        order: c.offset,
      });
    if (c.kind === "merge" && c.parent === parent) edits.push({ t: "del", index: c.index + 1 });
  }
  return mergeSequence(tokens, edits).map((t) => t.key);
}

function arrayList(node: string, path: Path, changes: readonly Change[], base: Table): unknown[] {
  const values = getIn(base.get(node)?.props, path) as unknown[];
  const tokens: Token[] = values.map((value, i) => ({ key: `e${i}`, value }));
  const edits: Edit[] = [];
  const here = (c: Change): boolean => "node" in c && c.node === node;
  for (const c of changes) {
    if (!here(c)) continue;
    if (c.kind === "arrayInsert" && same(c.path, path))
      edits.push({
        t: "ins",
        gap: c.index,
        tokens: c.values.map((value, i) => ({ key: `n${c.origin.replica}${i}`, value })),
        origin: originOf(c),
        rank: 1,
      });
    else if (c.kind === "arrayDelete" && same(c.path, path))
      c.values.forEach((_v, i) => edits.push({ t: "del", index: c.index + i }));
    else if (c.kind === "arrayMove" && same(c.path, path)) {
      edits.push({ t: "del", index: c.from });
      edits.push({
        t: "ins",
        gap: c.gap,
        tokens: [tokens[c.from] as Token],
        origin: originOf(c),
        rank: 1,
      });
    } else if ((c.kind === "set" || c.kind === "delta") && strictPrefix(path, c.path)) {
      const index = Number(c.path[path.length]);
      const rest = c.path.slice(path.length + 1);
      const apply =
        c.kind === "set"
          ? (value: unknown) => setIn(value, rest, c.after)
          : (value: unknown) => setIn(value, rest, Number(getIn(value, rest)) + c.by);
      edits.push({ t: "mod", index, apply });
    }
  }
  return mergeSequence(tokens, edits).map((t) => t.value);
}

/** Texts per run id of one group of adjacent runs (split boundaries start new runs). */
function textGroup(first: string, changes: readonly Change[], base: Table): Record<string, string> {
  const runs = groupOf(base, first);
  const tokens: Token[] = [];
  const start = new Map<string, number>();
  runs.forEach((run, j) => {
    if (j > 0) tokens.push({ key: `b:${run}`, value: { boundary: run } });
    start.set(run, tokens.length);
    codePoints(textOf(base.get(run))).forEach((ch, i) =>
      tokens.push({ key: `${run}#${i}`, value: ch }),
    );
  });
  const edits: Edit[] = [];
  const dropped = new Set<string>();
  for (const c of changes) {
    const at = start.get("node" in c ? c.node : c.kind === "nodeDelete" ? c.subtree.id : "");
    if (at === undefined) continue;
    if (c.kind === "textInsert")
      edits.push({
        t: "ins",
        gap: at + c.offset,
        tokens: codePoints(c.text).map((ch, i) => ({ key: `${c.origin.replica}+${i}`, value: ch })),
        origin: originOf(c),
        rank: 1,
      });
    if (c.kind === "textDelete")
      codePoints(c.text).forEach((_ch, i) => edits.push({ t: "del", index: at + c.offset + i }));
    if (c.kind === "split")
      edits.push({
        t: "ins",
        gap: at + c.offset,
        tokens: [{ key: `b:${c.other}`, value: { boundary: c.other } }],
        origin: originOf(c),
        rank: 2,
      });
    if (c.kind === "merge") edits.push({ t: "del", index: (start.get(c.other) ?? 0) - 1 });
    if (c.kind === "nodeDelete") {
      const run = c.subtree.id;
      dropped.add(run);
      if (at > 0 && runs.indexOf(run) > 0) edits.push({ t: "del", index: at - 1 });
      codePoints(textOf(base.get(run))).forEach((_ch, i) =>
        edits.push({ t: "del", index: at + i }),
      );
    }
  }
  const texts: Record<string, string> = {};
  let current = runs[0] ?? first;
  texts[current] = "";
  for (const token of mergeSequence(tokens, edits)) {
    const value = token.value;
    if (typeof value === "object" && value !== null) {
      current = (value as { boundary: string }).boundary;
      texts[current] = "";
    } else texts[current] += String(value);
  }
  for (const run of dropped) delete texts[run];
  return texts;
}

/** The same sequence observed in an actual table. */
export function observedSequence(seq: string, expected: unknown, table: Table): unknown {
  const [kind, id, path] = seq.split("|") as [string, string, string | undefined];
  if (kind === "children") return table.get(id)?.children ?? null;
  if (kind === "array")
    return getIn(table.get(id)?.props, JSON.parse(path ?? "[]") as Path) ?? null;
  const out: Record<string, string | null> = {};
  for (const run of Object.keys(expected as Record<string, string>))
    out[run] = table.has(run) ? textOf(table.get(run)) : null;
  return out;
}
