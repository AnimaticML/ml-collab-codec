import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { CHANGE_KINDS } from "../../src/core/change.ts";
import type { Change } from "../../src/core/change.ts";
import { TEXT_TAG, textOf } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { author, INSTANCES, pairBase } from "../support/ot/fixture.ts";
import type { Instance } from "../support/ot/fixture.ts";
import { runMatrix, summarize } from "../support/ot/matrix.ts";
import type { PairCase } from "../support/ot/matrix.ts";

let computed: PairCase[] | undefined;
/** The matrix runs inside the tests (not at load), so any failure is an assertion, not a crash. */
function allCases(): PairCase[] {
  computed ??= runMatrix();
  return computed;
}

function find(label: string): Instance {
  const instance = INSTANCES.find((i) => i.label === label);
  if (instance === undefined) throw new Error(`no instance ${label}`);
  return instance;
}

/** Merge two labelled instances (a by replica-a, b by replica-b) through the real transform. */
function merged(x: string, y: string): Table | string {
  const base = pairBase();
  const a = author(find(x), base, "replica-a");
  const b = author(find(y), base, "replica-b");
  const pair = transformPair(a, b);
  if (isConflict(pair)) return pair.conflict;
  return applyChanges(applyChanges(base, a), pair.b);
}

const runsOf = (table: Table | string, parent: string): string[] =>
  typeof table === "string"
    ? [table]
    : (table.get(parent)?.children ?? []).map((id) =>
        table.get(id)?.tag === TEXT_TAG ? textOf(table.get(id)) : `<${table.get(id)?.tag}>`,
      );

describe("MR34–MR35 operation-pair inventory and boundary geometries", () => {
  test("MR34 Complete ordered-pair inventory over the real primitive kinds", () => {
    const cases = allCases();
    // Adding a primitive kind without instances (and thus cells) fails here.
    expect(new Set(INSTANCES.map((i) => i.kind))).toEqual(new Set(CHANGE_KINDS));
    const cells = summarize(cases);
    expect(cells.size).toBe(CHANGE_KINDS.length * CHANGE_KINDS.length);
    for (const x of CHANGE_KINDS)
      for (const y of CHANGE_KINDS) {
        const cell = cells.get(`${x}×${y}`);
        expect({ cell: `${x}×${y}`, covered: (cell?.cases ?? 0) >= 6 }).toEqual({
          cell: `${x}×${y}`,
          covered: true,
        });
      }
    // Every case is classified by the spec-derived oracle; none is an unexplained failure.
    const failures = cases.filter((c) => c.outcome === "failure");
    expect(failures.map((c) => `${c.id}: ${c.problems.join("; ")}`)).toEqual([]);
    const outcomes = new Set(cases.map((c) => c.outcome));
    expect(outcomes).toEqual(new Set(["compatible", "conflict", "refusal"]));
  });

  test("MR35 Boundary geometries, both precedences, and independent semantic examples", () => {
    const cases = allCases();
    const geometries = new Set(cases.map((c) => c.geometry));
    for (const required of [
      "text: same gap",
      "text: gap inside",
      "text: gap at start",
      "text: gap at end",
      "text: overlap",
      "text: containment",
      "text: equal",
      "text: touching",
      "text: adjacent runs",
      "array: same gap",
      "array: gap inside",
      "array: equal",
      "array: containment",
      "array: touching",
      "children: same gap",
      "children: equal",
      "children: touching",
      "same node",
      "ancestor/descendant",
      "root and a descendant",
      "independent targets",
    ])
      expect({ required, present: geometries.has(required) }).toEqual({ required, present: true });
    // Both origin precedences ran for every ordered pair.
    expect(cases.filter((c) => c.precedence === "b-first")).toHaveLength(cases.length / 2);

    // Hand-derived expectations (SPEC §18.4), independent of the matrix oracle:
    // an insertion inside a concurrently deleted range survives ("abcdef" − "bcd" + X at 3).
    expect(runsOf(merged("r1 inside", "r1 [1,4)"), "p1")).toEqual(["aXef", "ij", "<em>"]);
    // Same-gap insertions order by stable origin: replica-a before replica-b.
    expect(runsOf(merged("r1 inside", "r1 inside other"), "p1")[0]).toBe("abcXYdef");
    expect(runsOf(merged("r1 inside other", "r1 inside"), "p1")[0]).toBe("abcYXdef");
    // Text inserted at a split point stays on the left run; the continuation stays glued.
    expect(runsOf(merged("r1 inside", "r1 at 3"), "p1")).toEqual(["abcX", "def", "ij", "<em>"]);
    // A node inserted between two runs that are concurrently merged is a structure conflict.
    expect(merged("p1 between r1 and r2", "r1+r2")).toBe("structure");
    // Text typed into the absorbed run follows it into the merged run.
    expect(runsOf(merged("r2 start", "r1+r2"), "p1")).toEqual(["abcdefQij", "<em>"]);
    // Equal duplicate values are distinct occurrences: deleting the second "a" keeps the first.
    const second = merged("items[2] (second a)", "items at 0");
    expect(typeof second !== "string" && second.get("$root")?.props["items"]).toEqual([
      "z",
      "a",
      "b",
      { k: 1 },
    ]);
    // Different writes to one field conflict; equal writes agree.
    expect(merged("root title", "root title other value")).toBe("concurrentWrite");
    expect(typeof merged("root title", "root title same value")).not.toBe("string");
    // Moves that jointly form a cycle are refused when applied, never merged into a cycle.
    const cycle = cases.find((c) => c.id.startsWith("nodeMove:p2 into p3 × nodeMove:s1 into p2"));
    expect(cycle?.outcome).toBe("refusal");
    const change: Change | undefined = author(find("r1 astral"), pairBase(), "replica-a")[0];
    expect(change?.kind === "textInsert" && [...change.text].length).toBe(1);
  });
});
