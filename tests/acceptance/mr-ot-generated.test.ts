import { describe, expect, test } from "bun:test";
import { CHANGE_KINDS } from "../../src/core/change.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { randomChange, randomTable } from "../support/gen.ts";
import type { Tally } from "../support/ot/generated.ts";
import { dense, randomPair, sweep } from "../support/ot/generated.ts";
import { predict } from "../support/ot/oracle.ts";
import { rng, seedBudget } from "../support/random.ts";

/** Per-class thresholds for the fixed CI seeds (actual counts: `bun run ot:report`). */
function expectHealthy(tally: Tally, total: number, minCompatible: number): void {
  expect(tally.failures).toEqual([]);
  expect(tally.outcomes.failure).toBe(0);
  expect(tally.outcomes.compatible + tally.outcomes.conflict + tally.outcomes.refusal).toBe(total);
  expect(tally.outcomes.compatible / total).toBeGreaterThan(minCompatible);
  expect(tally.outcomes.conflict).toBeGreaterThan(0);
  // The generator reaches every primitive kind, not just the easy ones.
  for (const kind of CHANGE_KINDS)
    expect({ kind, seen: (tally.kinds.get(kind) ?? 0) > 20 }).toEqual({ kind, seen: true });
}

describe("MR36 generated histories are fully classified", () => {
  test("MR36 random documents and composite changes: no skipped outcomes", () => {
    // The algebra budget is separate from the history/simulation budget and never below 3000.
    const seeds = seedBudget(3000, "ALGEBRA");
    const tally = sweep(seeds, (r) => randomPair(r));
    expectHealthy(tally, seeds.length, 0.5);
    const collisions = sweep(seeds, (r) => randomPair(r, true));
    expectHealthy(collisions, seeds.length, 0.4);
    // The transform's own verdict is not the oracle: single generated primitives are checked
    // against the spec-derived predicate (conflict exactly when SPEC §18.4 says so).
    const disagreements: string[] = [];
    for (const seed of seedBudget(2000, "ALGEBRA")) {
      const r = rng(seed);
      const base = r.chance(0.5) ? dense() : randomTable(r);
      const [a] = randomChange(base, r, "replica-a", 1, 1);
      const [b] = randomChange(base, r, "replica-b", 1, 1);
      if (a === undefined || b === undefined) continue;
      const expected = predict(a, b, base) === "conflict";
      if (isConflict(transformPair([a], [b])) !== expected)
        disagreements.push(`seed ${seed}: ${a.kind}/${b.kind} expected conflict=${expected}`);
    }
    expect(disagreements).toEqual([]);
  });
});
