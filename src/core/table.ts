import type { ComponentNode, ContentItem, DocumentModel, JsonObject } from "./types.ts";
import { diag, DiagnosticError } from "./diagnostics.ts";
import { PersistentTable } from "./persistent-table.ts";
import { copyJsonStrict } from "./json-copy.ts";

/**
 * The flat node-table working representation used by the operation engine.
 * Every row -- including text runs ("#text") -- has an id; its position is
 * its index in the parent's ordered `children` list. Only rows whose
 * `persisted` flag is set surface as a public `ComponentNode.id`; text-run and
 * anonymous-node ids are internal handles (SPEC 6). The document root is
 * always addressed as `$root`; its own persistent id, if any, is `rootId`.
 *
 * Ownership: rows are frozen and shared between versions; `props` and
 * `children` are borrowed read-only views (deeply `readonly` in the types).
 * Library operations never mutate them; mutating them through casts is
 * outside the supported contract.
 */
export interface TableNode {
  readonly id: string;
  readonly tag: string;
  readonly props: JsonObject;
  readonly parentId: string | null;
  readonly children: readonly string[];
  readonly persisted: boolean;
  /** Only on the `$root` row: the document root's persistent id. */
  readonly rootId?: string;
}

export type Table = ReadonlyMap<string, TableNode>;

export const ROOT_ID = "$root";
export const TEXT_TAG = "#text";
const MAX_DEPTH = 256;

/** Deterministic internal-handle allocator for decoding (same document ⇒ same handles). */
export function createAllocator(prefix = "t"): () => string {
  let counter = 0;
  return () => `${prefix}${counter++}`;
}

export function children(table: Table, parentId: string): TableNode[] {
  const parent = table.get(parentId);
  if (parent === undefined) return [];
  return parent.children.flatMap((id) => {
    const row = table.get(id);
    return row === undefined ? [] : [row];
  });
}

export function textOf(row: TableNode | undefined): string {
  const value = row?.props["value"];
  return typeof value === "string" ? value : "";
}

export function makeRow(
  id: string,
  tag: string,
  props: JsonObject,
  parentId: string | null,
  childIds: readonly string[],
  persisted: boolean,
): TableNode {
  // The row is frozen; its child list is a private copy typed `readonly` but not frozen:
  // freezing large arrays is costly (and slows later lookups) in JavaScriptCore.
  return Object.freeze({ id, tag, props, parentId, children: [...childIds], persisted });
}

/** Copy a row with some fields replaced, preserving every other field (including `rootId`). */
export function reshapeRow(
  row: TableNode,
  patch: Partial<Pick<TableNode, "tag" | "props" | "parentId" | "children">>,
): TableNode {
  const next = { ...row, ...patch, children: [...(patch.children ?? row.children)] };
  return Object.freeze(next);
}

function ingest(
  table: Map<string, TableNode>,
  item: ContentItem,
  parentId: string,
  allocate: () => string,
  depth: number,
): string {
  if (depth > MAX_DEPTH)
    throw new DiagnosticError([
      diag("limitExceeded", "$", "document nesting exceeds the supported depth"),
    ]);
  if (typeof item === "string") {
    const id = allocate();
    table.set(id, makeRow(id, TEXT_TAG, { value: item }, parentId, [], false));
    return id;
  }
  const id = item.id ?? allocate();
  const childIds = (item.content ?? []).map((child) =>
    ingest(table, child, id, allocate, depth + 1),
  );
  table.set(
    id,
    makeRow(
      id,
      item.tag,
      copyJsonStrict(item.props) as JsonObject,
      parentId,
      childIds,
      item.id !== undefined,
    ),
  );
  return id;
}

function collectPersistedIds(node: ComponentNode, into: Set<string>, depth: number): Set<string> {
  if (depth > MAX_DEPTH)
    throw new DiagnosticError([
      diag("limitExceeded", "$", "document nesting exceeds the supported depth"),
    ]);
  for (const item of node.content ?? []) {
    if (typeof item === "string") continue;
    if (item.id !== undefined) {
      if (into.has(item.id) || item.id === ROOT_ID)
        throw new DiagnosticError([diag("duplicateId", "$", `duplicate id "${item.id}"`)]);
      into.add(item.id);
    }
    collectPersistedIds(item, into, depth + 1);
  }
  return into;
}

/**
 * Build the operational table (structural only; it does not apply a schema).
 * Props are acquired by deep copy, so the caller may keep editing its model.
 * Internal handles never reuse an id the document carries; a duplicate
 * persisted id is an error, never a silently merged row.
 */
export function toTable(model: DocumentModel, allocate: () => string): Table {
  const rootId = model.root.id;
  const used = collectPersistedIds(
    model.root,
    new Set(rootId === undefined ? [ROOT_ID] : [ROOT_ID, rootId]),
    0,
  );
  const fresh = (): string => {
    for (;;) {
      const id = allocate();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const table = new Map<string, TableNode>();
  const childIds = (model.root.content ?? []).map((item) => ingest(table, item, ROOT_ID, fresh, 1));
  const root = makeRow(
    ROOT_ID,
    model.root.tag,
    copyJsonStrict(model.root.props) as JsonObject,
    null,
    childIds,
    false,
  );
  table.set(ROOT_ID, rootId === undefined ? root : Object.freeze({ ...root, rootId }));
  return PersistentTable.from(table);
}

/** Adjacent text runs are one effective string; empty runs are no content (SPEC 3.3). */
function buildContent(table: Table, parentId: string): ContentItem[] {
  const content: ContentItem[] = [];
  for (const child of children(table, parentId)) {
    if (child.tag !== TEXT_TAG) {
      content.push(buildNode(table, child));
      continue;
    }
    const text = textOf(child);
    if (text.length === 0) continue;
    const last = content[content.length - 1];
    if (typeof last === "string") content[content.length - 1] = last + text;
    else content.push(text);
  }
  return content;
}

function buildNode(table: Table, node: TableNode): ComponentNode {
  const content = buildContent(table, node.id);
  const id = node.id === ROOT_ID ? node.rootId : node.persisted ? node.id : undefined;
  return id === undefined
    ? { tag: node.tag, props: node.props, content }
    : { id, tag: node.tag, props: node.props, content };
}

/** A read-only view of the table as a document model (props are shared with the table's rows). */
export function fromTable(table: Table, schemaId: string, schemaVersion: string): DocumentModel {
  const rootRow = table.get(ROOT_ID);
  if (rootRow === undefined) throw new Error("table has no root");
  return { schemaId, schemaVersion, root: buildNode(table, rootRow) };
}
