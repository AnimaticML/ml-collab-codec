import type { ComponentNode, ContentItem, DocumentModel, JsonObject } from "./types.ts";
import { diag, DiagnosticError } from "./diagnostics.ts";
import { PersistentTable } from "./persistent-table.ts";

/**
 * The flat node-table working representation used by the operation engine.
 * Every row -- including text runs ("#text") -- has an id; its position is
 * its index in the parent's ordered `children` list (not a client-chosen
 * order key). Only rows whose `persisted` flag is set surface as a public
 * `ComponentNode.id`; text-run and anonymous-node ids are internal handles
 * (SPEC 6: not every object or character needs a persisted identity).
 */
export interface TableNode {
  readonly id: string;
  readonly tag: string;
  readonly props: JsonObject;
  readonly parentId: string | null;
  readonly children: readonly string[];
  readonly persisted: boolean;
}

export type Table = ReadonlyMap<string, TableNode>;

export const ROOT_ID = "$root";
export const TEXT_TAG = "#text";

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

function ingest(
  table: Map<string, TableNode>,
  item: ContentItem,
  parentId: string,
  allocate: () => string,
): string {
  if (typeof item === "string") {
    const id = allocate();
    table.set(id, makeRow(id, TEXT_TAG, { value: item }, parentId, [], false));
    return id;
  }
  const id = item.id ?? allocate();
  const childIds = (item.content ?? []).map((child) => ingest(table, child, id, allocate));
  table.set(id, makeRow(id, item.tag, item.props, parentId, childIds, item.id !== undefined));
  return id;
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

/** Convert a document into an operational table. The root row always has id "$root". */
function collectPersistedIds(node: ComponentNode, into: Set<string>): Set<string> {
  for (const item of node.content ?? []) {
    if (typeof item === "string") continue;
    if (item.id !== undefined) {
      if (into.has(item.id) || item.id === ROOT_ID)
        throw new DiagnosticError([diag("duplicateId", "$", `duplicate id "${item.id}"`)]);
      into.add(item.id);
    }
    collectPersistedIds(item, into);
  }
  return into;
}

/**
 * Build the operational table. Internal handles for anonymous nodes and text runs
 * never reuse an id the document already carries (a document may legitimately use
 * ids like "t1"); a duplicate persisted id is an error, never a silently merged row.
 */
export function toTable(model: DocumentModel, allocate: () => string): Table {
  const used = collectPersistedIds(model.root, new Set([ROOT_ID]));
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
  const childIds = (model.root.content ?? []).map((item) => ingest(table, item, ROOT_ID, fresh));
  table.set(ROOT_ID, makeRow(ROOT_ID, model.root.tag, model.root.props, null, childIds, false));
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
  const built: ComponentNode = {
    tag: node.tag,
    props: node.props,
    content: buildContent(table, node.id),
  };
  return node.persisted ? { ...built, id: node.id } : built;
}

export function fromTable(table: Table, schemaId: string, schemaVersion: string): DocumentModel {
  const rootRow = table.get(ROOT_ID);
  if (rootRow === undefined) throw new Error("table has no root");
  return { schemaId, schemaVersion, root: buildNode(table, rootRow) };
}
