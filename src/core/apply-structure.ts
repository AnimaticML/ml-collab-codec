import type { ChangeOf, SubtreeRecord } from "./change.ts";
import { codePointLength } from "./change.ts";
import { deepEqual } from "./normalize.ts";
import type { JsonValue } from "./types.ts";
import type { TableNode } from "./table.ts";
import { makeRow, TEXT_TAG, textOf } from "./table.ts";
import { ApplyError, type StagedTable } from "./staging.ts";

type StructuralChange = ChangeOf<"nodeInsert" | "nodeDelete" | "nodeMove" | "split" | "merge">;

function requireContainer(staged: StagedTable, id: string): TableNode {
  const row = staged.require(id);
  if (row.tag === TEXT_TAG) throw new ApplyError("invalidTarget", "text runs have no children");
  return row;
}

function withChildren(row: TableNode, childIds: readonly string[]): TableNode {
  return makeRow(row.id, row.tag, row.props, row.parentId, childIds, row.persisted);
}

function childAt(parent: TableNode, index: number, expectedId: string): void {
  if (parent.children[index] !== expectedId)
    throw new ApplyError(
      "preconditionFailed",
      `node ${expectedId} is not at the recorded position`,
    );
}

function checkGap(parent: TableNode, gap: number): void {
  if (!Number.isSafeInteger(gap) || gap < 0 || gap > parent.children.length)
    throw new ApplyError("outOfRange", "child position out of range");
}

/** Read back a complete subtree record for precondition checks and deletion payloads. */
export function readSubtree(staged: { require(id: string): TableNode }, id: string): SubtreeRecord {
  const row = staged.require(id);
  return {
    id: row.id,
    tag: row.tag,
    props: row.props,
    persisted: row.persisted,
    children: row.children.map((child) => readSubtree(staged, child)),
  };
}

function installSubtree(staged: StagedTable, record: SubtreeRecord, parentId: string): void {
  if (staged.has(record.id))
    throw new ApplyError("idCollision", `node id ${record.id} is already in use`);
  if (
    record.tag === TEXT_TAG &&
    (record.children.length > 0 || typeof record.props["value"] !== "string")
  )
    throw new ApplyError("invalidTarget", "a text run needs a string value and no children");
  const ids = record.children.map((child) => child.id);
  staged.set(makeRow(record.id, record.tag, record.props, parentId, ids, record.persisted));
  for (const child of record.children) installSubtree(staged, child, record.id);
}

function removeSubtree(staged: StagedTable, id: string): void {
  const row = staged.require(id);
  for (const child of row.children) removeSubtree(staged, child);
  staged.delete(id);
}

function applyInsert(staged: StagedTable, change: ChangeOf<"nodeInsert">): void {
  const parent = requireContainer(staged, change.parent);
  checkGap(parent, change.index);
  installSubtree(staged, change.subtree, parent.id);
  const ids = [...parent.children];
  ids.splice(change.index, 0, change.subtree.id);
  staged.set(withChildren(parent, ids));
}

function applyDelete(staged: StagedTable, change: ChangeOf<"nodeDelete">): void {
  const parent = requireContainer(staged, change.parent);
  childAt(parent, change.index, change.subtree.id);
  const current = readSubtree(staged, change.subtree.id);
  if (!deepEqual(current as unknown as JsonValue, change.subtree as unknown as JsonValue))
    throw new ApplyError("preconditionFailed", "deleted subtree differs from the record");
  removeSubtree(staged, change.subtree.id);
  const ids = [...parent.children];
  ids.splice(change.index, 1);
  staged.set(withChildren(parent, ids));
}

function isWithin(staged: StagedTable, id: string, ancestor: string): boolean {
  for (
    let cursor: string | null = id;
    cursor !== null;
    cursor = staged.get(cursor)?.parentId ?? null
  )
    if (cursor === ancestor) return true;
  return false;
}

function applyMove(staged: StagedTable, change: ChangeOf<"nodeMove">): void {
  const from = requireContainer(staged, change.fromParent);
  childAt(from, change.fromIndex, change.node);
  const to = requireContainer(staged, change.toParent);
  checkGap(to, change.gap);
  if (isWithin(staged, change.toParent, change.node))
    throw new ApplyError("cycle", "move would place a node inside itself");
  const node = staged.require(change.node);
  if (from.id === to.id) {
    const ids = [...from.children];
    ids.splice(change.fromIndex, 1);
    ids.splice(change.gap > change.fromIndex ? change.gap - 1 : change.gap, 0, change.node);
    staged.set(withChildren(from, ids));
    return;
  }
  const fromIds = [...from.children];
  fromIds.splice(change.fromIndex, 1);
  const toIds = [...to.children];
  toIds.splice(change.gap, 0, change.node);
  staged.set(withChildren(from, fromIds));
  staged.set(withChildren(to, toIds));
  staged.set(makeRow(node.id, node.tag, node.props, to.id, node.children, node.persisted));
}

function requireRun(staged: StagedTable, id: string): TableNode {
  const row = staged.require(id);
  if (row.tag !== TEXT_TAG) throw new ApplyError("invalidTarget", "split/merge targets text runs");
  return row;
}

function applySplit(staged: StagedTable, change: ChangeOf<"split">): void {
  const parent = requireContainer(staged, change.parent);
  childAt(parent, change.index, change.node);
  const run = requireRun(staged, change.node);
  const chars = [...textOf(run)];
  if (!Number.isSafeInteger(change.offset) || change.offset < 0 || change.offset > chars.length)
    throw new ApplyError("outOfRange", "split offset out of range");
  if (staged.has(change.other))
    throw new ApplyError("idCollision", `node id ${change.other} is already in use`);
  staged.set({ ...run, props: { value: chars.slice(0, change.offset).join("") } });
  staged.set(
    makeRow(
      change.other,
      TEXT_TAG,
      { value: chars.slice(change.offset).join("") },
      parent.id,
      [],
      false,
    ),
  );
  const ids = [...parent.children];
  ids.splice(change.index + 1, 0, change.other);
  staged.set(withChildren(parent, ids));
}

function applyMerge(staged: StagedTable, change: ChangeOf<"merge">): void {
  const parent = requireContainer(staged, change.parent);
  childAt(parent, change.index, change.node);
  childAt(parent, change.index + 1, change.other);
  const run = requireRun(staged, change.node);
  const absorbed = requireRun(staged, change.other);
  if (codePointLength(textOf(run)) !== change.offset)
    throw new ApplyError("preconditionFailed", "merge boundary differs from the record");
  staged.set({ ...run, props: { value: textOf(run) + textOf(absorbed) } });
  staged.delete(change.other);
  const ids = [...parent.children];
  ids.splice(change.index + 1, 1);
  staged.set(withChildren(parent, ids));
}

export function applyStructural(staged: StagedTable, change: StructuralChange): void {
  switch (change.kind) {
    case "nodeInsert":
      return applyInsert(staged, change);
    case "nodeDelete":
      return applyDelete(staged, change);
    case "nodeMove":
      return applyMove(staged, change);
    case "split":
      return applySplit(staged, change);
    case "merge":
      return applyMerge(staged, change);
  }
}
