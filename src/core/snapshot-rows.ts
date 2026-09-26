import { DecodeError, jsonValue } from "./change-codec.ts";
import { DOCUMENT_LIMITS } from "./document-check.ts";
import { PersistentTable } from "./persistent-table.ts";
import type { SchemaProfile } from "./schema.ts";
import type { Table, TableNode } from "./table.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "./table.ts";
import type { JsonObject } from "./types.ts";
import { isJsonObject } from "./types.ts";
import { validateTable } from "./validate.ts";

/** A snapshot (checkpoint or bootstrap) that is malformed, inconsistent, or schema-invalid. */
export class SnapshotError extends Error {}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > DOCUMENT_LIMITS.maxIdLength)
    throw new SnapshotError(`${path} must be a non-empty string of bounded length`);
  return value;
}

function decodeRow(value: unknown, i: number): TableNode {
  const path = `rows[${i}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SnapshotError(`${path} must be an object`);
  const raw = value as Record<string, unknown>;
  const id = text(raw["id"], `${path}.id`);
  const tag = text(raw["tag"], `${path}.tag`);
  const parent = raw["parentId"];
  if (parent !== null) text(parent, `${path}.parentId`);
  const children = raw["children"];
  if (!Array.isArray(children)) throw new SnapshotError(`${path}.children must be an array`);
  children.forEach((child, k) => text(child, `${path}.children[${k}]`));
  if (typeof raw["persisted"] !== "boolean")
    throw new SnapshotError(`${path}.persisted must be a boolean`);
  let props: JsonObject;
  try {
    const decoded = jsonValue(raw["props"], `${path}.props`);
    if (!isJsonObject(decoded)) throw new DecodeError(`${path}.props`, "expected an object");
    props = decoded;
  } catch (error) {
    if (error instanceof DecodeError) throw new SnapshotError(error.message);
    throw error;
  }
  if (tag === TEXT_TAG && (children.length > 0 || typeof props["value"] !== "string"))
    throw new SnapshotError(`${path} is a text run with children or without a string value`);
  const row = makeRow(
    id,
    tag,
    props,
    parent as string | null,
    children as string[],
    raw["persisted"],
  );
  const rootId = raw["rootId"];
  if (rootId === undefined) return row;
  if (id !== ROOT_ID) throw new SnapshotError(`${path}.rootId is only allowed on the root row`);
  return Object.freeze({ ...row, rootId: text(rootId, `${path}.rootId`) });
}

/** Every row is reachable from the root exactly once, within the depth and size bounds. */
function checkTree(table: ReadonlyMap<string, TableNode>): void {
  const root = table.get(ROOT_ID);
  if (root === undefined || root.parentId !== null)
    throw new SnapshotError("the snapshot has no root row");
  const seen = new Set<string>([ROOT_ID]);
  const stack: [TableNode, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [row, depth] = stack.pop() as [TableNode, number];
    if (depth > DOCUMENT_LIMITS.maxDepth) throw new SnapshotError("snapshot nesting is too deep");
    for (const id of row.children) {
      const child = table.get(id);
      if (child === undefined) throw new SnapshotError(`row ${row.id} lists missing child ${id}`);
      if (seen.has(id)) throw new SnapshotError(`row ${id} is listed more than once (cycle)`);
      if (child.parentId !== row.id)
        throw new SnapshotError(`row ${id} names parent ${String(child.parentId)}, not ${row.id}`);
      seen.add(id);
      stack.push([child, depth + 1]);
    }
  }
  if (seen.size !== table.size) throw new SnapshotError("the snapshot has unreachable rows");
}

/**
 * Strict, bounded import of operational rows (internal handles preserved):
 * well-formed rows, unique ids, one root, consistent parent/child links,
 * no cycles or orphans, and — when a schema is supplied — schema validity.
 * Nothing is constructed for the caller unless every check passes.
 */
export function readRows(value: unknown, schema?: SchemaProfile): Table {
  if (!Array.isArray(value)) throw new SnapshotError("rows must be an array");
  if (value.length > DOCUMENT_LIMITS.maxNodes) throw new SnapshotError("too many rows");
  const table = new Map<string, TableNode>();
  value.forEach((raw, i) => {
    const row = decodeRow(raw, i);
    if (table.has(row.id)) throw new SnapshotError(`duplicate row id ${row.id}`);
    table.set(row.id, row);
  });
  checkTree(table);
  const result = PersistentTable.from(table);
  if (schema !== undefined) {
    const issues = validateTable(result, schema);
    if (issues.length > 0)
      throw new SnapshotError(`snapshot is not schema-valid: ${issues[0]?.message ?? ""}`);
  }
  return result;
}

/** Rows in a canonical order for serialization. */
export function sortedRows(table: Table): TableNode[] {
  return [...table.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
