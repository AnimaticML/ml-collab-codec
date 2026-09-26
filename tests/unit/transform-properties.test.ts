import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { invertChanges } from "../../src/core/change.ts";
import type { Change } from "../../src/core/change.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { ApplyError } from "../../src/core/staging.ts";
import type { Table } from "../../src/core/table.ts";
import { canonicalTable, randomChange, randomTable, tableFrom } from "../support/gen.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "../../src/core/table.ts";
import { rng, seedBudget } from "../support/random.ts";

function tryApply(table: Table, changes: readonly Change[]): Table | ApplyError {
  try {
    return applyChanges(table, changes);
  } catch (error) {
    if (error instanceof ApplyError) return error;
    throw error;
  }
}

function roundTrip(changes: readonly Change[]): Change[] {
  return JSON.parse(JSON.stringify(changes)) as Change[];
}

describe("transform algebra properties (seeded)", () => {
  test("TP1 convergence, closure under transform, and state-free inversion", () => {
    let compatible = 0;
    let conflicts = 0;
    for (const seed of seedBudget(3000)) {
      const r = rng(seed);
      const base = randomTable(r);
      const a = randomChange(base, r, "replica-a", 1, 3);
      const b = randomChange(base, r, "replica-b", 1, 3);
      const pair = transformPair(a, b);
      if (isConflict(pair)) {
        conflicts += 1;
        continue;
      }
      const sa = applyChanges(base, a);
      const sb = applyChanges(base, b);
      const left = tryApply(sa, pair.b);
      const right = tryApply(sb, pair.a);
      if (left instanceof ApplyError || right instanceof ApplyError) {
        // Only an apply-time structural check (a move cycle) may refuse a transformed form.
        const refused = [left, right].filter((x) => x instanceof ApplyError);
        expect({ seed, codes: refused.map((e) => e.code) }).toEqual({
          seed,
          codes: refused.map(() => "cycle"),
        });
        continue;
      }
      compatible += 1;
      expect({ seed, state: canonicalTable(left) }).toEqual({ seed, state: canonicalTable(right) });
      // Inversion from the serialized transformed record alone restores the concurrent base.
      expect({
        seed,
        back: canonicalTable(applyChanges(right, invertChanges(roundTrip(pair.a)))),
      }).toEqual({
        seed,
        back: canonicalTable(sb),
      });
      expect(canonicalTable(applyChanges(sa, invertChanges(roundTrip(a))))).toBe(
        canonicalTable(base),
      );
    }
    expect(compatible).toBeGreaterThan(conflicts);
  });

  test("TP1 on a dense single-paragraph document (maximal same-target collisions)", () => {
    let compatible = 0;
    for (const seed of seedBudget(3000)) {
      const r = rng(seed);
      const base = tableFrom([
        makeRow(ROOT_ID, "doc", { items: ["a", "a", "b"], title: "t" }, null, ["p0"], false),
        makeRow("p0", "p", { n: 1, tags: ["a", "b"] }, ROOT_ID, ["r0", "r1", "e0"], true),
        makeRow("r0", TEXT_TAG, { value: "abcd" }, "p0", [], false),
        makeRow("r1", TEXT_TAG, { value: "ef" }, "p0", [], false),
        makeRow("e0", "em", {}, "p0", ["r2"], false),
        makeRow("r2", TEXT_TAG, { value: "gh" }, "e0", [], false),
      ]);
      const a = randomChange(base, r, "replica-a", 1, 3);
      const b = randomChange(base, r, "replica-b", 1, 3);
      const pair = transformPair(a, b);
      if (isConflict(pair)) continue;
      const left = tryApply(applyChanges(base, a), pair.b);
      const right = tryApply(applyChanges(base, b), pair.a);
      if (left instanceof ApplyError || right instanceof ApplyError) continue;
      compatible += 1;
      expect({ seed, state: canonicalTable(left) }).toEqual({ seed, state: canonicalTable(right) });
    }
    expect(compatible).toBeGreaterThan(1500);
  });
});
