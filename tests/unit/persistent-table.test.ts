import { describe, expect, test } from "bun:test";
import { PersistentTable } from "../../src/core/persistent-table.ts";
import { makeRow, ROOT_ID } from "../../src/core/table.ts";
import type { TableNode } from "../../src/core/table.ts";
import { rng, seedBudget } from "../support/random.ts";

const row = (id: string, value = 0): TableNode => makeRow(id, "n", { value }, ROOT_ID, [], true);

function rows(count: number): Map<string, TableNode> {
  return new Map(Array.from({ length: count }, (_, i) => [`n${i}`, row(`n${i}`)]));
}

describe("PersistentTable", () => {
  test("derived versions are isolated and agree with a plain Map model", () => {
    for (const seed of seedBudget(40)) {
      const r = rng(seed);
      const model = rows(r.int(200));
      let table = PersistentTable.from(model);
      const versions: [PersistentTable, Map<string, TableNode>][] = [[table, new Map(model)]];
      for (let step = 0; step < 30; step += 1) {
        const writes = new Map<string, TableNode | null>();
        for (let k = 0; k < 1 + r.int(5); k += 1) {
          const id = `n${r.int(260)}`;
          writes.set(id, r.chance(0.3) ? null : row(id, step));
        }
        for (const [id, value] of writes) {
          if (value === null) model.delete(id);
          else model.set(id, value);
        }
        table = table.with(writes);
        versions.push([table, new Map(model)]);
      }
      for (const [version, expected] of versions) {
        expect(version.size).toBe(expected.size);
        expect(new Map(version)).toEqual(expected);
        for (const id of expected.keys()) expect(version.get(id)).toBe(expected.get(id));
        expect(version.has("missing")).toBe(false);
      }
    }
  });

  test("an edit shares every untouched row and costs far less than a full copy", () => {
    const base = PersistentTable.from(rows(60_000));
    const next = base.with(new Map([["n42", row("n42", 1)]]));
    expect(next.get("n42")?.props["value"]).toBe(1);
    expect(base.get("n42")?.props["value"]).toBe(0);
    for (const id of ["n0", "n1", "n59999"]) expect(next.get(id)).toBe(base.get(id));
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) base.with(new Map([[`n${i}`, row(`n${i}`, i)]]));
    // A full copy of 60k entries takes milliseconds; bucketed sharing stays well below that.
    expect((performance.now() - started) / 200).toBeLessThan(1);
  });

  test("growth rebuilds the bucket layout without losing rows", () => {
    let table = PersistentTable.from(new Map<string, TableNode>());
    for (let chunk = 0; chunk < 20; chunk += 1) {
      const writes = new Map<string, TableNode | null>();
      for (let i = 0; i < 500; i += 1) writes.set(`g${chunk}-${i}`, row(`g${chunk}-${i}`));
      table = table.with(writes);
    }
    expect(table.size).toBe(10_000);
    expect([...table.keys()].length).toBe(10_000);
    expect(table.get("g19-499")?.id).toBe("g19-499");
    let visited = 0;
    table.forEach(() => (visited += 1));
    expect(visited).toBe(10_000);
  });
});
