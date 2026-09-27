import { expect } from "bun:test";
import { ChangeBuilder } from "../../src/core/builder.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { ApplyError } from "../../src/core/staging.ts";
import { createAllocator, ROOT_ID, toTable } from "../../src/core/table.ts";
import { validateTable } from "../../src/core/validate.ts";
import { CATALOG_SOURCE, catalogSchema } from "./catalog-schema.ts";
import { rng, seedBudget } from "./random.ts";

/** Random valid/invalid edits: the incremental validator and full validation must agree. */
export function differential(): void {
  const parsed = parseDocument(CATALOG_SOURCE, catalogSchema);
  if (!parsed.ok) throw new Error("setup");
  const base = toTable(parsed.value, createAllocator());
  const validate = schemaValidator(catalogSchema);
  const disagreements: string[] = [];
  let rejected = 0;
  for (const seed of seedBudget(300, "SCHEMA")) {
    const r = rng(seed);
    const b = new ChangeBuilder(base, { replica: "replica-d", seq: seed });
    const refRow = [...base.values()].find((row) => row.tag === "ref")?.id ?? "";
    const commands: (() => void)[] = [
      () => b.set(ROOT_ID, ["limits", "low"], r.pick([0, 3, -1, "x"])),
      () => b.set(ROOT_ID, "tags", r.pick([["a"], ["a", "b", "c", "d"], [1]])),
      () => b.set(ROOT_ID, "title", r.pick(["x", undefined])),
      () => b.set("i1", "sku", r.pick(["bolt-1", "other"])),
      () => b.set(refRow, "target", r.pick(["bolt-1", "none"])),
      () =>
        void b.insertNode(
          r.pick(["g1", "g2", ROOT_ID]),
          0,
          r.pick([
            { tag: "item", id: `x${seed}` },
            { tag: "ref", props: {} },
            { tag: "group", id: `y${seed}` },
          ]),
        ),
      () => b.moveNode(r.pick(["i1", "g2"]), r.pick(["g1", ROOT_ID]), 0),
      () => b.deleteNode(r.pick(["i1", "g2", refRow])),
      () => b.delta(ROOT_ID, r.pick(["count", ["limits", "low"]]), 1),
      () => b.arrayInsert(ROOT_ID, ["rows"], 0, [r.pick([{ name: "n" }, { qty: 1 }])]),
    ];
    try {
      for (let i = 0; i < 1 + r.int(3); i += 1) r.pick(commands)();
    } catch (error) {
      // An edit that does not apply to this state was never authored: nothing to compare.
      if (error instanceof ApplyError) continue;
      throw error;
    }
    const candidate = b.current();
    const additive = b.changes.every((c) => c.kind !== "delta" || c.path[0] === "count");
    const full = additive && validateTable(candidate, catalogSchema).length === 0;
    const fast = validate(candidate, b.changes, base) === null;
    if (!fast) rejected += 1;
    if (full !== fast)
      disagreements.push(`seed ${seed}: full ${String(full)} incremental ${String(fast)}`);
  }
  expect(disagreements).toEqual([]);
  expect(rejected).toBeGreaterThan(30);
}
