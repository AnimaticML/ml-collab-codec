import { describe, expect, test } from "bun:test";
import { seedBudget } from "../support/random.ts";
import type { SimStats } from "../support/sim.ts";
import { shrinkHistory, simulateHistory } from "../support/sim.ts";

describe("MR37 state-machine histories with validators, checkpoints, and joins", () => {
  test("MR37 Generated histories converge with coherent intermediate views", () => {
    const steps = Number(process.env["PROPERTY_STEPS"] ?? "60");
    const stats: SimStats[] = [];
    for (const seed of seedBudget(120, "HISTORY")) {
      const failure = simulateHistory(seed, steps, stats);
      if (failure !== null) {
        const minimal = shrinkHistory(seed, steps);
        throw new Error(
          `seed ${seed} fails (minimal ${minimal} steps): ${simulateHistory(seed, minimal) ?? failure}`,
        );
      }
    }
    // What the histories exercised (the generator cannot silently stop reaching these paths).
    const total = (key: keyof SimStats): number => stats.reduce((sum, s) => sum + s[key], 0);
    for (const key of [
      "applied",
      "rejected",
      "resyncs",
      "checkpoints",
      "joins",
      "restored",
      "unavailable",
      "undo",
    ] as const)
      expect({ key, reached: total(key) > 0 }).toEqual({ key, reached: true });
  });
});
