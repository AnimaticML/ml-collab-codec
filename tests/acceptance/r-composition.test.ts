import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import type { ChangeBuilder } from "../../src/core/builder.ts";
import type { Change } from "../../src/core/change.ts";
import { codePointLength, invertChanges } from "../../src/core/change.ts";
import { compose } from "../../src/core/compose.ts";
import type { Table } from "../../src/core/table.ts";
import { TEXT_TAG, textOf } from "../../src/core/table.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { canonicalTable, randomChange, randomTable } from "../support/gen.ts";
import { rng, seedBudget, type Rng } from "../support/random.ts";
import { build } from "../support/requests.ts";

type Step = (builder: ChangeBuilder, table: Table, index: number) => void;

/** A run of own primitives that `compose` merges: typing, backspace, forward delete, set or delta chain. */
function ownRun(table: Table, r: Rng): Change[][] {
  const runs = [...table.values()].filter((row) => row.tag === TEXT_TAG);
  const run = r.pick(runs);
  const length = codePointLength(textOf(run));
  const start = r.int(length + 1);
  const count = 2 + r.int(4);
  const steps: Step[] = [
    (b, _t, i) => b.textInsert(run.id, start + i, r.pick(["a", "Ё", "😀"])),
    (b, _t, i) => (start - i > 0 ? b.textDelete(run.id, start - i - 1, 1) : undefined),
    (b, t) =>
      codePointLength(textOf(t.get(run.id))) > start ? b.textDelete(run.id, start, 1) : undefined,
    (b) => b.set("p0", "title", r.pick(["u", "v", "w"])),
    (b) => b.delta("p0", "n", r.pick([1, 2, -1])),
  ];
  const step = r.pick(steps);
  const parts: Change[][] = [];
  let state = table;
  for (let index = 0; index < count; index += 1) {
    const part = build(state, "replica-a", index + 1, (b) => step(b, state, index));
    if (part.length === 0) break;
    parts.push(part);
    state = applyChanges(state, part);
  }
  return parts;
}

/** Map `own` (applied first) past `other` part by part, as the history maps a handle. */
function sequential(own: readonly Change[][], other: readonly Change[]) {
  let incoming = other;
  const mapped: Change[] = [];
  for (const part of own) {
    const pair = transformPair(part, incoming);
    if (isConflict(pair)) return pair;
    mapped.push(...pair.a);
    incoming = pair.b;
  }
  return { a: mapped, b: incoming };
}

function effect(change: Change): unknown {
  if (change.kind !== "set" && change.kind !== "delta") return change;
  const { origin: _origin, ...rest } = change;
  return rest;
}

function after(table: Table, ...lists: (readonly Change[])[]): string {
  return canonicalTable(lists.reduce<Table>((state, list) => applyChanges(state, list), table));
}

/**
 * Composed and part-wise transformation give the same converged states and
 * the composite adds no conflict, with two justified exceptions. A
 * composite that is a no-op after the other side (net zero, or its net
 * write already made there) cannot conflict even where a part would. An
 * assignment chain is judged on its net write: part-wise, a step that
 * coincides with the other side's write is absorbed and later steps then
 * overwrite that write unnoticed, so only the composite reports the conflict.
 */
function agree(
  seed: number,
  table: Table,
  parts: readonly Change[][],
  composed: readonly Change[],
  other: Change[],
) {
  const whole = transformPair(composed, other);
  const split = sequential(parts, other);
  const assignments = parts.every((part) => part.every((change) => change.kind === "set"));
  if (isConflict(whole) && !assignments)
    expect({ seed, split: isConflict(split) }).toEqual({ seed, split: true });
  if (!isConflict(whole) && isConflict(split))
    expect({ seed, absorbed: whole.a }).toEqual({ seed, absorbed: [] });
  if (isConflict(whole) || isConflict(split)) return;
  expect(after(table, other, whole.a)).toBe(after(table, other, split.a));
  expect(after(table, composed, whole.b)).toBe(after(table, ...parts, split.b));
}

describe("R13 composed own runs transform like their parts", () => {
  test("R13 Transforming against a composed run equals transforming against its parts", () => {
    let merged = 0;
    for (const seed of seedBudget(300, "ALGEBRA")) {
      const r = rng(seed);
      const table = randomTable(r);
      const parts = ownRun(table, r);
      if (parts.length < 2) continue;
      const composed = parts.reduce<Change[]>((acc, part) => compose(acc, part), []);
      if (composed.length < parts.length) merged += 1;
      const end = after(table, ...parts);
      expect({ seed, end: after(table, composed) }).toEqual({ seed, end });
      // Handle form: the group's inverses composed newest first equal the composed run's inverse
      // (assignment and delta origins are inert, so they are compared without them).
      const inverses = [...parts]
        .reverse()
        .reduce<Change[]>((acc, part) => compose(acc, invertChanges(part)), []);
      expect({ seed, inverses: inverses.map(effect) }).toEqual({
        seed,
        inverses: invertChanges(composed).map(effect),
      });
      // Concurrent with the run (recovery log, rebasing) and after it (handle mapping).
      agree(seed, table, parts, composed, randomChange(table, r, "replica-b", 1, 2));
      const later = randomChange(applyChanges(table, composed), r, "replica-b", 1, 2);
      const reversed = [...parts].reverse().map((part) => invertChanges(part));
      agree(seed, applyChanges(table, composed), reversed, invertChanges(composed), later);
    }
    expect(merged).toBeGreaterThan(50);
  });
});
