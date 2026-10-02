import { describe, expect, test } from "bun:test";
import type { Change, ChangeOf } from "../../src/core/change.ts";
import { invertChanges } from "../../src/core/change.ts";
import { RecoveryLog } from "../../src/core/history-log.ts";
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
/** Entries at consecutive revisions starting from 1. */
const at = (...entries: Omit<LogEntry, "revision">[]): LogEntry[] =>
  entries.map((entry, index) => ({ ...entry, revision: index + 1 }));

describe("history recovery cancellation", () => {
  test("an own undo cancels its group's effect and rewrites the entries between", () => {
    const undo = invertChanges([insert(0, "ab", 1)]);
    const reduced = cancelPairs(
      at(
        { changes: [insert(0, "ab", 1)], own: own("g", "do") },
        { changes: [insert(2, "R", 2)] },
        { changes: undo, own: own("g", "undo") },
      ),
    );
    expect(reduced).toEqual([{ revision: 2, changes: [insert(0, "R", 2)] }]);
  });

  test("an undo that does not match the reversed effect cancels nothing", () => {
    const forged: Change = {
      kind: "textDelete",
      node: "t",
      offset: 0,
      text: "a",
      origin: origin(3),
    };
    const entries = at(
      { changes: [insert(0, "ab", 1)], own: own("g", "do") },
      { changes: [forged], own: own("g", "undo") },
    );
    expect(cancelPairs(entries)).toBeUndefined();
  });

  test("remote entries and other groups are never cancelled", () => {
    const entries = at(
      { changes: [insert(0, "ab", 1)] },
      { changes: [insert(0, "cd", 2)], own: own("other", "do") },
      { changes: invertChanges([insert(0, "ab", 1)]), own: own("g", "undo") },
    );
    expect(cancelPairs(entries)).toBeUndefined();
  });

  test("a redo cancels only the latest undo of its group and keeps the remainder", () => {
    const extra = insert(5, "x", 4);
    const reduced = cancelPairs(
      at(
        { changes: invertChanges([insert(0, "ab", 1)]), own: own("g", "undo") },
        { changes: [insert(0, "ab", 1), extra], own: own("g", "redo") },
      ),
    );
    expect(reduced).toEqual([{ revision: 2, changes: [extra], own: own("g", "redo") }]);
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

describe("shared recovery log", () => {
  const fill = (log: RecoveryLog, count: number) => {
    for (let revision = 1; revision <= count; revision += 1)
      log.append({ revision, changes: [insert(0, "x", revision)] });
  };

  test("keeps transitions after the oldest needed context and none when nothing is degraded", () => {
    const log = new RecoveryLog(0);
    fill(log, 5);
    log.retain(2, 5);
    expect(log.covers(2)).toBe(true);
    expect(log.covers(1)).toBe(false);
    expect(log.reducedAfter(2)?.map((entry) => entry.revision)).toEqual([3, 4, 5]);
    log.retain(undefined, 5);
    expect(log.export()).toEqual({ start: 5, entries: [] });
  });

  test("an optional cap drops the oldest transitions and the contexts before them", () => {
    const log = new RecoveryLog(0, 3);
    fill(log, 5);
    log.retain(0, 5);
    expect(log.export().entries.map((entry) => entry.revision)).toEqual([3, 4, 5]);
    expect(log.covers(0)).toBe(false);
    expect(log.covers(2)).toBe(true);
    expect(() => new RecoveryLog(0, -1)).toThrow(RangeError);
  });

  test("reduction is a fold: each own undo cancels as it arrives, cached per context", () => {
    const log = new RecoveryLog(0);
    for (const entry of at(
      { changes: [insert(0, "ab", 1)], own: own("g", "do") },
      { changes: [insert(2, "R", 2)] },
      { changes: invertChanges([insert(0, "ab", 1)]), own: own("g", "undo") },
    ))
      log.append(entry);
    const reduced = log.reducedAfter(0);
    expect(reduced).toEqual([{ revision: 2, changes: [insert(0, "R", 2)] }]);
    expect(log.reducedAfter(0)).toBe(reduced);
  });
});
