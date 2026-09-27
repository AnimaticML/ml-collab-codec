import { applyChanges } from "../../../src/core/apply.ts";
import type { Change, ChangeKind } from "../../../src/core/change.ts";
import { invertChanges } from "../../../src/core/change.ts";
import { ApplyError } from "../../../src/core/staging.ts";
import type { Table } from "../../../src/core/table.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "../../../src/core/table.ts";
import { isConflict, transformPair } from "../../../src/core/transform.ts";
import { canonicalTable, randomChange, randomTable, tableFrom } from "../gen.ts";
import type { Rng } from "../random.ts";
import { rng } from "../random.ts";

/** Every generated pair ends in exactly one of these classes; `failure` must stay empty. */
export type Outcome = "compatible" | "conflict" | "refusal" | "failure";

export interface Tally {
  readonly outcomes: Record<Outcome, number>;
  readonly kinds: Map<ChangeKind, number>;
  readonly failures: string[];
}

function tryApply(table: Table, changes: readonly Change[]): Table | ApplyError {
  try {
    return applyChanges(table, changes);
  } catch (error) {
    if (error instanceof ApplyError) return error;
    throw error;
  }
}

const roundTrip = (changes: readonly Change[]): Change[] =>
  JSON.parse(JSON.stringify(changes)) as Change[];

/**
 * Classify one generated pair. Compatible pairs must satisfy TP1 and
 * state-free inversion from serialized records on both branches; the only
 * admissible apply-time refusals are move cycles and persisted-id
 * collisions. Any other application error is a failure with its seed.
 */
function classify(seed: number, base: Table, a: Change[], b: Change[], tally: Tally): Outcome {
  for (const change of [...a, ...b])
    tally.kinds.set(change.kind, (tally.kinds.get(change.kind) ?? 0) + 1);
  const pair = transformPair(a, b);
  if (isConflict(pair)) return "conflict";
  const sa = applyChanges(base, a);
  const sb = applyChanges(base, b);
  const left = tryApply(sa, pair.b);
  const right = tryApply(sb, pair.a);
  if (left instanceof ApplyError || right instanceof ApplyError) {
    const codes = [left, right].flatMap((x) => (x instanceof ApplyError ? [x.code] : []));
    if (codes.every((code) => code === "cycle" || code === "idCollision")) return "refusal";
    tally.failures.push(`seed ${seed}: unexpected apply error ${codes.join(",")}`);
    return "failure";
  }
  const problems: string[] = [];
  if (canonicalTable(left) !== canonicalTable(right)) problems.push("TP1");
  if (canonicalTable(applyChanges(right, invertChanges(roundTrip(pair.a)))) !== canonicalTable(sb))
    problems.push("inverse of a'");
  if (canonicalTable(applyChanges(left, invertChanges(roundTrip(pair.b)))) !== canonicalTable(sa))
    problems.push("inverse of b'");
  if (canonicalTable(applyChanges(sa, invertChanges(roundTrip(a)))) !== canonicalTable(base))
    problems.push("inverse of a");
  if (problems.length === 0) return "compatible";
  tally.failures.push(`seed ${seed}: ${problems.join(", ")}`);
  return "failure";
}

export function sweep(
  seeds: readonly number[],
  build: (r: Rng) => { base: Table; a: Change[]; b: Change[] },
): Tally {
  const tally: Tally = {
    outcomes: { compatible: 0, conflict: 0, refusal: 0, failure: 0 },
    kinds: new Map(),
    failures: [],
  };
  for (const seed of seeds) {
    const { base, a, b } = build(rng(seed));
    tally.outcomes[classify(seed, base, a, b, tally)] += 1;
  }
  return tally;
}

export function dense(): Table {
  return tableFrom([
    makeRow(ROOT_ID, "doc", { items: ["a", "a", "b"], title: "t" }, null, ["p0"], false),
    makeRow("p0", "p", { n: 1, tags: ["a", "b"] }, ROOT_ID, ["r0", "r1", "e0"], true),
    makeRow("r0", TEXT_TAG, { value: "abcd" }, "p0", [], false),
    makeRow("r1", TEXT_TAG, { value: "ef" }, "p0", [], false),
    makeRow("e0", "em", {}, "p0", ["r2"], false),
    makeRow("r2", TEXT_TAG, { value: "gh" }, "e0", [], false),
  ]);
}

/** Two random composite changes (1..3 primitives each) on a random or the dense document. */
export function randomPair(r: Rng, onDense = false): { base: Table; a: Change[]; b: Change[] } {
  const base = onDense ? dense() : randomTable(r);
  return {
    base,
    a: randomChange(base, r, "replica-a", 1, 3),
    b: randomChange(base, r, "replica-b", 1, 3),
  };
}
