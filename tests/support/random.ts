/** Small deterministic PRNG (mulberry32) so every generated case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function rng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (max) => Math.floor(next() * max),
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from empty list");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: (p) => next() < p,
  };
}

/**
 * Seed budget for one suite. Normal CI runs `defaultCount` seeds; the larger
 * reproducible job raises it through `PROPERTY_BUDGET_<SUITE>` or the shared
 * `PROPERTY_BUDGET`. A configured budget can only raise a suite's count, so
 * a quick setting for one suite never silently reduces another's coverage.
 */
export function seedBudget(defaultCount: number, suite?: string): number[] {
  const named = suite === undefined ? undefined : process.env[`PROPERTY_BUDGET_${suite}`];
  const configured = Number(named ?? process.env["PROPERTY_BUDGET"] ?? "");
  const count = Number.isSafeInteger(configured)
    ? Math.max(defaultCount, configured)
    : defaultCount;
  const start = Number(process.env["PROPERTY_SEED_START"] ?? "1");
  return Array.from({ length: count }, (_, i) => (Number.isSafeInteger(start) ? start : 1) + i);
}
