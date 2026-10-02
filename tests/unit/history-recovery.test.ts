import { describe, expect, test } from "bun:test";
import type { Change, ChangeOf } from "../../src/core/change.ts";
import { invertChanges } from "../../src/core/change.ts";
import { cancelPairs, degraded, type LogEntry } from "../../src/core/history-recovery.ts";

const origin = (seq: number) => ({ replica: "r", seq, ordinal: 0 });
const insert = (offset: number, text: string, seq: number): ChangeOf<"textInsert"> => ({
  kind: "textInsert",
  node: "t",
  offset,
  text,
  origin: origin(seq),
});
const own = (group: string, kind: "do" | "undo" | "redo") => ({ group, kind }) as const;

describe("history recovery cancellation", () => {
  test("an own undo cancels its group's effect and rewrites the entries between", () => {
    const done = insert(0, "ab", 1);
    const remote: LogEntry = { changes: [insert(2, "R", 2)] };
    const undo = invertChanges([insert(0, "ab", 1)]);
    const reduced = cancelPairs([
      { changes: [done], own: own("g", "do") },
      remote,
      { changes: undo, own: own("g", "undo") },
    ]);
    expect(reduced).toEqual([{ changes: [insert(0, "R", 2)] }]);
  });

  test("an undo that does not match the reversed effect cancels nothing", () => {
    const forged: Change = {
      kind: "textDelete",
      node: "t",
      offset: 0,
      text: "a",
      origin: origin(3),
    };
    const entries: LogEntry[] = [
      { changes: [insert(0, "ab", 1)], own: own("g", "do") },
      { changes: [forged], own: own("g", "undo") },
    ];
    expect(cancelPairs(entries)).toBeUndefined();
  });

  test("remote entries and other groups are never cancelled", () => {
    const entries: LogEntry[] = [
      { changes: [insert(0, "ab", 1)] },
      { changes: [insert(0, "cd", 2)], own: own("other", "do") },
      { changes: invertChanges([insert(0, "ab", 1)]), own: own("g", "undo") },
    ];
    expect(cancelPairs(entries)).toBeUndefined();
  });

  test("a redo cancels only the latest undo of its group and keeps the remainder", () => {
    const undo = invertChanges([insert(0, "ab", 1)]);
    const extra = insert(5, "x", 4);
    const reduced = cancelPairs([
      { changes: undo, own: own("g", "undo") },
      { changes: [insert(0, "ab", 1), extra], own: own("g", "redo") },
    ]);
    expect(reduced).toEqual([{ changes: [extra], own: own("g", "redo") }]);
  });

  test("position-only mapping is not degradation; shortened content is", () => {
    const original = insert(0, "ab", 1);
    const before = { changes: [original], dropped: 0 };
    expect(degraded(before, { changes: [{ ...original, offset: 3 }], dropped: 0 })).toBe(false);
    expect(degraded(before, { changes: [{ ...original, text: "a" }], dropped: 0 })).toBe(true);
    expect(degraded(before, { changes: [], dropped: 1 })).toBe(true);
    expect(degraded(before, { conflict: "x" })).toBe(true);
  });
});
