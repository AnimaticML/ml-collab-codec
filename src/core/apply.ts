import { isJsonArray } from "./types.ts";
import type { JsonValue } from "./types.ts";
import type { Change, ChangeOf } from "./change.ts";
import { codePointLength } from "./change.ts";
import { deepEqual } from "./normalize.ts";
import { getAtPath, PathError, setAtPath } from "./json-path.ts";
import type { PropPath } from "./json-path.ts";
import type { Table, TableNode } from "./table.ts";
import { TEXT_TAG, textOf } from "./table.ts";
import { ApplyError, StagedTable } from "./staging.ts";
import { applyStructural } from "./apply-structure.ts";

function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return deepEqual(a, b);
}

function requireProps(staged: StagedTable, id: string): TableNode {
  const row = staged.require(id);
  if (row.tag === TEXT_TAG)
    throw new ApplyError("invalidTarget", "text runs change through text primitives");
  return row;
}

function writeProp(
  staged: StagedTable,
  row: TableNode,
  path: PropPath,
  value: JsonValue | undefined,
): void {
  try {
    staged.set({ ...row, props: setAtPath(row.props, path, value) });
  } catch (error) {
    if (error instanceof PathError) throw new ApplyError("outOfRange", error.message);
    throw error;
  }
}

function applySet(staged: StagedTable, change: ChangeOf<"set">): void {
  const row = requireProps(staged, change.node);
  if (!sameValue(getAtPath(row.props, change.path), change.before))
    throw new ApplyError(
      "preconditionFailed",
      "current value differs from the recorded before value",
    );
  writeProp(staged, row, change.path, change.after);
}

/** Additive profile: JSON safe integers only; no rounding, wrapping, or implicit zero. */
function applyDelta(staged: StagedTable, change: ChangeOf<"delta">): void {
  const row = requireProps(staged, change.node);
  const current = getAtPath(row.props, change.path);
  if (typeof current !== "number" || !Number.isSafeInteger(current))
    throw new ApplyError("numericProfile", "additive target is not a safe integer");
  if (!Number.isSafeInteger(change.by))
    throw new ApplyError("numericProfile", "delta is not a safe integer");
  const next = current + change.by;
  if (!Number.isSafeInteger(next))
    throw new ApplyError("numericProfile", "additive result leaves the safe-integer range");
  writeProp(staged, row, change.path, next);
}

function readArray(row: TableNode, path: PropPath): readonly JsonValue[] {
  const value = getAtPath(row.props, path);
  if (!isJsonArray(value)) throw new ApplyError("preconditionFailed", "target is not an array");
  return value;
}

function checkRange(index: number, length: number, count: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index + count > length)
    throw new ApplyError("outOfRange", "sequence position out of range");
}

function applyArray(
  staged: StagedTable,
  change: ChangeOf<"arrayInsert" | "arrayDelete" | "arrayMove">,
): void {
  const row = requireProps(staged, change.node);
  const array = [...readArray(row, change.path)];
  if (change.kind === "arrayInsert") {
    checkRange(change.index, array.length, 0);
    array.splice(change.index, 0, ...change.values);
  } else if (change.kind === "arrayDelete") {
    checkRange(change.index, array.length, change.values.length);
    const removed = array.splice(change.index, change.values.length);
    if (!removed.every((value, i) => deepEqual(value, change.values[i] as JsonValue)))
      throw new ApplyError("preconditionFailed", "removed occurrences differ from the record");
  } else {
    checkRange(change.from, array.length, 1);
    checkRange(change.gap, array.length, 0);
    const [moved] = array.splice(change.from, 1);
    array.splice(change.gap > change.from ? change.gap - 1 : change.gap, 0, moved as JsonValue);
  }
  writeProp(staged, row, change.path, array);
}

function requireText(staged: StagedTable, id: string): { row: TableNode; chars: string[] } {
  const row = staged.require(id);
  if (row.tag !== TEXT_TAG) throw new ApplyError("invalidTarget", "target is not a text run");
  return { row, chars: [...textOf(row)] };
}

function applyText(staged: StagedTable, change: ChangeOf<"textInsert" | "textDelete">): void {
  const { row, chars } = requireText(staged, change.node);
  const length = codePointLength(change.text);
  if (change.kind === "textInsert") {
    checkRange(change.offset, chars.length, 0);
    chars.splice(change.offset, 0, change.text);
  } else {
    checkRange(change.offset, chars.length, length);
    const removed = chars.splice(change.offset, length).join("");
    if (removed !== change.text)
      throw new ApplyError("preconditionFailed", "removed text differs from the record");
  }
  staged.set({ ...row, props: { ...row.props, value: chars.join("") } });
}

export function applyChangeTo(staged: StagedTable, change: Change): void {
  switch (change.kind) {
    case "set":
      return applySet(staged, change);
    case "delta":
      return applyDelta(staged, change);
    case "arrayInsert":
    case "arrayDelete":
    case "arrayMove":
      return applyArray(staged, change);
    case "textInsert":
    case "textDelete":
      return applyText(staged, change);
    default:
      return applyStructural(staged, change);
  }
}

/** Apply a sequential composite to a private candidate. Throws {@link ApplyError}; the input table is never mutated. */
export function applyChanges(table: Table, changes: readonly Change[]): Table {
  const staged = new StagedTable(table);
  for (const change of changes) applyChangeTo(staged, change);
  return staged.freeze();
}
