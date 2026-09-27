import { applyChanges } from "../../../src/core/apply.ts";
import type { Change, ChangeKind } from "../../../src/core/change.ts";
import { invertChanges } from "../../../src/core/change.ts";
import { canonicalJson, decodeChanges } from "../../../src/core/change-codec.ts";
import { ApplyError } from "../../../src/core/staging.ts";
import type { Table } from "../../../src/core/table.ts";
import { ROOT_ID } from "../../../src/core/table.ts";
import { isConflict, transformPair } from "../../../src/core/transform.ts";
import type { Transformed } from "../../../src/core/transform.ts";
import { canonicalTable } from "../gen.ts";
import type { Instance } from "./fixture.ts";
import { author, INSTANCES, pairBase } from "./fixture.ts";
import type { Expectation } from "./oracle.ts";
import { expectedSequence, observedSequence, predict, sameEffect, sequences } from "./oracle.ts";

export interface PairCase {
  readonly id: string;
  readonly cell: `${ChangeKind}×${ChangeKind}`;
  readonly geometry: string;
  readonly precedence: "a-first" | "b-first";
  readonly expected: Expectation;
  readonly outcome: Expectation | "failure";
  readonly problems: readonly string[];
}

function tryApply(table: Table, changes: readonly Change[]): Table | ApplyError {
  try {
    return applyChanges(table, changes);
  } catch (error) {
    if (error instanceof ApplyError) return error;
    throw error;
  }
}

type Range = readonly [number, number];

/** Position of a primitive in one touched sequence, in base coordinates (a gap is an empty range). */
function rangeIn(c: Change, seq: string): Range | undefined {
  const [kind] = seq.split("|");
  if (kind === "children") {
    if (c.kind === "nodeInsert") return [c.index, c.index];
    if (c.kind === "nodeDelete") return [c.index, c.index + 1];
    if (c.kind === "nodeMove")
      return `children|${c.fromParent}` === seq ? [c.fromIndex, c.fromIndex + 1] : [c.gap, c.gap];
    if (c.kind === "split") return [c.index + 1, c.index + 1];
    if (c.kind === "merge") return [c.index + 1, c.index + 2];
  }
  if (kind === "array") {
    if (c.kind === "arrayInsert") return [c.index, c.index];
    if (c.kind === "arrayDelete") return [c.index, c.index + c.values.length];
    if (c.kind === "arrayMove") return [c.from, c.from + 1];
    if ("path" in c) {
      const depth = (JSON.parse(seq.split("|")[2] ?? "[]") as unknown[]).length;
      const i = Number(c.path[depth]);
      return [i, i + 1];
    }
  }
  if (
    kind === "text" &&
    (c.kind === "textInsert" || c.kind === "textDelete" || c.kind === "split")
  ) {
    const n = c.kind === "textDelete" ? [...c.text].length : 0;
    return [c.offset, c.offset + n];
  }
  return undefined;
}

function relation(x: Range, y: Range): string {
  const [s1, e1] = x;
  const [s2, e2] = y;
  if (s1 === e1 && s2 === e2) return s1 === s2 ? "same gap" : s1 < s2 ? "before" : "after";
  if (s1 === e1 || s2 === e2) {
    const [g, [s, e]] = s1 === e1 ? [s1, y] : [s2, x];
    return g < s
      ? "gap before"
      : g === s
        ? "gap at start"
        : g < e
          ? "gap inside"
          : g === e
            ? "gap at end"
            : "gap after";
  }
  if (s1 === s2 && e1 === e2) return "equal";
  if (e1 === s2 || e2 === s1) return "touching";
  if (e1 < s2 || e2 < s1) return "disjoint";
  if ((s1 <= s2 && e2 <= e1) || (s2 <= s1 && e1 <= e2)) return "containment";
  return "overlap";
}

function ancestors(base: Table, id: string): Set<string> {
  const out = new Set<string>();
  for (let c = base.get(id)?.parentId ?? null; c !== null; c = base.get(c)?.parentId ?? null)
    out.add(c);
  return out;
}

function geometry(a: Change, b: Change, base: Table): string {
  const shared = sequences(a, base).filter((s) => sequences(b, base).includes(s));
  for (const seq of shared) {
    if (seq.startsWith("text|") && "node" in a && "node" in b && a.node !== b.node)
      return "text: adjacent runs";
    const x = rangeIn(a, seq);
    const y = rangeIn(b, seq);
    if (x !== undefined && y !== undefined) return `${seq.split("|")[0] ?? ""}: ${relation(x, y)}`;
  }
  if (shared.length > 0) return `${shared[0]?.split("|")[0] ?? ""}: shared list`;
  const target = (c: Change): string =>
    "node" in c
      ? c.node
      : c.kind === "nodeDelete"
        ? c.subtree.id
        : c.kind === "nodeInsert"
          ? c.parent
          : "";
  const [ta, tb] = [target(a), target(b)];
  if (ta === tb) return "same node";
  if (ta === ROOT_ID || tb === ROOT_ID) return "root and a descendant";
  if (ancestors(base, ta).has(tb) || ancestors(base, tb).has(ta)) return "ancestor/descendant";
  return "independent targets";
}

/** Checks of a compatible transformed pair against TP1, the oracle, inversion, and serialization. */
function checkCompatible(
  base: Table,
  a: readonly Change[],
  b: readonly Change[],
  pair: Transformed,
  left: Table,
  right: Table,
): string[] {
  const problems: string[] = [];
  const sa = applyChanges(base, a);
  const sb = applyChanges(base, b);
  if (canonicalTable(left) !== canonicalTable(right)) problems.push("TP1: branches diverge");
  const [x, y] = [a[0] as Change, b[0] as Change];
  const seqs = [...new Set([...sequences(x, base), ...sequences(y, base)])];
  const shared = sequences(x, base).some((s) => sequences(y, base).includes(s));
  if (sameEffect(x, y)) {
    if (canonicalTable(left) !== canonicalTable(sa))
      problems.push("oracle: equal effect applied twice");
  } else if (!shared) {
    const raw = tryApply(sa, b);
    if (raw instanceof ApplyError || canonicalTable(raw) !== canonicalTable(left))
      problems.push("oracle: independent primitives do not commute");
  }
  for (const seq of sameEffect(x, y) ? [] : seqs) {
    const expected = expectedSequence(seq, [...a, ...b], base);
    const observed = observedSequence(seq, expected, left);
    if (canonicalJson(expected) !== canonicalJson(observed))
      problems.push(
        `oracle ${seq}: expected ${canonicalJson(expected)}, got ${canonicalJson(observed)}`,
      );
  }
  const undoB = tryApply(left, invertChanges(pair.b));
  if (undoB instanceof ApplyError || canonicalTable(undoB) !== canonicalTable(sa))
    problems.push("inverse: undoing b' does not restore A's branch");
  const undoA = tryApply(right, invertChanges(pair.a));
  if (undoA instanceof ApplyError || canonicalTable(undoA) !== canonicalTable(sb))
    problems.push("inverse: undoing a' does not restore B's branch");
  for (const side of [pair.a, pair.b])
    if (canonicalJson(decodeChanges(JSON.parse(canonicalJson(side)))) !== canonicalJson(side))
      problems.push("serialization: transformed record does not round-trip");
  return problems;
}

function runCase(
  x: Instance,
  y: Instance,
  precedence: PairCase["precedence"],
  base: Table,
): PairCase {
  const [ra, rb] =
    precedence === "a-first" ? ["replica-a", "replica-b"] : ["replica-b", "replica-a"];
  const a = author(x, base, ra);
  const b = author(y, base, rb);
  const id = `${x.kind}:${x.label} × ${y.kind}:${y.label} (${precedence})`;
  const cell = `${x.kind}×${y.kind}` as const;
  const problems: string[] = [];
  if (a.length !== 1 || b.length !== 1) problems.push("instance is not a single primitive");
  const frozen = canonicalJson([a, b]);
  const expected = predict(a[0] as Change, b[0] as Change, base);
  const pair = transformPair(a, b);
  const reverse = transformPair(b, a);
  if (canonicalJson([a, b]) !== frozen) problems.push("isolation: inputs were mutated");
  const geo = geometry(a[0] as Change, b[0] as Change, base);
  const done = (outcome: PairCase["outcome"]): PairCase => ({
    id,
    cell,
    geometry: geo,
    precedence,
    expected,
    outcome: problems.length > 0 ? "failure" : outcome,
    problems,
  });
  if (isConflict(pair) !== isConflict(reverse)) problems.push("asymmetric conflict verdict");
  if (isConflict(pair) || isConflict(reverse)) {
    if (expected !== "conflict")
      problems.push(`unexpected conflict: ${isConflict(pair) ? pair.detail : ""}`);
    return done("conflict");
  }
  const left = tryApply(applyChanges(base, a), pair.b);
  const right = tryApply(applyChanges(base, b), pair.a);
  if (left instanceof ApplyError || right instanceof ApplyError) {
    const codes = [left, right].flatMap((r) => (r instanceof ApplyError ? [r.code] : []));
    if (expected !== "refusal" || codes.some((code) => code !== "cycle" && code !== "idCollision"))
      problems.push(`unexpected apply refusal ${codes.join(",")} (expected ${expected})`);
    return done("refusal");
  }
  if (expected !== "compatible") problems.push(`expected ${expected}, transform merged both`);
  problems.push(...checkCompatible(base, a, b, pair, left, right));
  const viaReverse = tryApply(applyChanges(base, a), reverse.a);
  if (viaReverse instanceof ApplyError || canonicalTable(viaReverse) !== canonicalTable(left))
    problems.push("argument order: transformPair(b, a) disagrees with transformPair(a, b)");
  return done("compatible");
}

/** Every ordered pair of instances, in both origin precedences. */
export function runMatrix(instances: readonly Instance[] = INSTANCES): PairCase[] {
  const base = pairBase();
  const cases: PairCase[] = [];
  for (const x of instances)
    for (const y of instances)
      for (const precedence of ["a-first", "b-first"] as const)
        cases.push(runCase(x, y, precedence, base));
  return cases;
}

/** Case counts by ordered kind pair, outcome, and geometry. */
export function summarize(
  cases: readonly PairCase[],
): Map<
  string,
  { cases: number; outcomes: Record<string, number>; geometries: Record<string, number> }
> {
  const cells = new Map<
    string,
    { cases: number; outcomes: Record<string, number>; geometries: Record<string, number> }
  >();
  for (const c of cases) {
    const cell = cells.get(c.cell) ?? { cases: 0, outcomes: {}, geometries: {} };
    cell.cases += 1;
    cell.outcomes[c.outcome] = (cell.outcomes[c.outcome] ?? 0) + 1;
    cell.geometries[c.geometry] = (cell.geometries[c.geometry] ?? 0) + 1;
    cells.set(c.cell, cell);
  }
  return cells;
}
