import type { ComponentNode, ContentItem } from "./types.ts";
import type { Change } from "./change.ts";
import type { AuthoredBy, NodeSpec } from "./builder.ts";
import { ChangeBuilder } from "./builder.ts";
import { diffProps } from "./diff-values.ts";
import { alignKeys } from "./diff-align.ts";
import { diffText } from "./diff-text.ts";
import { ApplyError } from "./staging.ts";
import type { Table, TableNode } from "./table.ts";
import { ROOT_ID, TEXT_TAG, textOf } from "./table.ts";

/** A table child list viewed as effective content: adjacent text runs form one segment. */
type Segment =
  | { readonly kind: "text"; readonly runs: readonly TableNode[] }
  | { readonly kind: "node"; readonly row: TableNode };

interface DiffContext {
  readonly builder: ChangeBuilder;
  /** Persisted ids present anywhere in the target: moved, never deleted and recreated. */
  readonly targetIds: ReadonlySet<string>;
}

function kids(ctx: DiffContext, parentId: string): TableNode[] {
  return (ctx.builder.read(parentId)?.children ?? []).flatMap((id) => {
    const row = ctx.builder.read(id);
    return row === undefined ? [] : [row];
  });
}

function segments(ctx: DiffContext, parentId: string): Segment[] {
  const out: Segment[] = [];
  for (const row of kids(ctx, parentId)) {
    const last = out[out.length - 1];
    if (row.tag !== TEXT_TAG) out.push({ kind: "node", row });
    else if (last?.kind === "text")
      out[out.length - 1] = { kind: "text", runs: [...last.runs, row] };
    else out.push({ kind: "text", runs: [row] });
  }
  return out;
}

function segmentKey(segment: Segment): string {
  // An all-empty text segment is no content: it never matches and is removed.
  if (segment.kind === "text")
    return segment.runs.some((run) => textOf(run).length > 0) ? TEXT_TAG : "#empty";
  return segment.row.persisted ? `id:${segment.row.id}` : `anon:${segment.row.tag}`;
}

function itemKey(item: ContentItem): string {
  if (typeof item === "string") return TEXT_TAG;
  return item.id === undefined ? `anon:${item.tag}` : `id:${item.id}`;
}

function spec(item: ContentItem): NodeSpec | string {
  if (typeof item === "string") return item;
  return {
    tag: item.tag,
    ...(item.id === undefined ? {} : { id: item.id }),
    props: item.props,
    children: (item.content ?? []).map(spec),
  };
}

function persistedIds(node: ComponentNode, into: Set<string> = new Set()): Set<string> {
  for (const item of node.content ?? []) {
    if (typeof item === "string") continue;
    if (item.id !== undefined) into.add(item.id);
    persistedIds(item, into);
  }
  return into;
}

function reusesExisting(ctx: DiffContext, item: ComponentNode): boolean {
  return (item.content ?? []).some(
    (child) =>
      typeof child !== "string" &&
      ((child.id !== undefined && ctx.builder.read(child.id) !== undefined) ||
        reusesExisting(ctx, child)),
  );
}

/** Place an existing row at final child index `index` of `parentId`. */
function moveTo(builder: ChangeBuilder, id: string, parentId: string, index: number): void {
  const at = builder.position(id);
  if (at.parent !== parentId) builder.moveNode(id, parentId, index);
  else if (at.index !== index) builder.moveNode(id, parentId, at.index > index ? index : index + 1);
}

/**
 * Before deleting a row that leaves the document, park its persisted
 * descendants that the target keeps at the end of `parentId`; they are
 * moved to their final place when the traversal reaches them.
 */
function rescue(ctx: DiffContext, rowId: string, parentId: string): void {
  for (const child of kids(ctx, rowId)) {
    if (child.persisted && ctx.targetIds.has(child.id)) {
      const end = ctx.builder.read(parentId)?.children.length ?? 0;
      ctx.builder.moveNode(child.id, parentId, end);
    } else rescue(ctx, child.id, parentId);
  }
}

function removeUnmatched(ctx: DiffContext, parentId: string, segment: Segment): void {
  if (segment.kind === "text") {
    for (const run of segment.runs) ctx.builder.deleteNode(run.id);
    return;
  }
  if (segment.row.persisted && ctx.targetIds.has(segment.row.id)) return;
  rescue(ctx, segment.row.id, parentId);
  ctx.builder.deleteNode(segment.row.id);
}

/** Bring an existing node (same identity) to the target's tag, props, and content. */
function reconcile(ctx: DiffContext, row: TableNode, item: ComponentNode): void {
  if (row.tag !== item.tag) ctx.builder.setTag(row.id, item.tag);
  const current = ctx.builder.read(row.id) ?? row;
  diffProps(ctx.builder, row.id, current.props, item.props);
  diffContent(ctx, row.id, item.content ?? []);
}

function placeNew(ctx: DiffContext, parentId: string, pos: number, item: ContentItem): void {
  const existing =
    typeof item === "string" || item.id === undefined ? undefined : ctx.builder.read(item.id);
  if (typeof item === "string" || (existing === undefined && !reusesExisting(ctx, item))) {
    ctx.builder.insertNode(parentId, pos, spec(item));
    return;
  }
  if (existing !== undefined) {
    moveTo(ctx.builder, existing.id, parentId, pos);
    reconcile(ctx, existing, item);
    return;
  }
  // A new node that contains persisted nodes still present elsewhere: create the shell,
  // then fill it so those nodes are moved in instead of recreated under the same id.
  const shell = ctx.builder.insertNode(parentId, pos, {
    ...(spec(item) as NodeSpec),
    children: [],
  });
  diffContent(ctx, shell, item.content ?? []);
}

/**
 * Align current segments with the target by identity keys (LCS), delete what
 * leaves, and place target items left to right: after item `i`, the first
 * rows of the parent are exactly the target's first `i` items.
 */
function diffContent(ctx: DiffContext, parentId: string, raw: readonly ContentItem[]): void {
  const target = raw.filter((item) => item !== "");
  const current = segments(ctx, parentId);
  const matches = alignKeys(current.map(segmentKey), target.map(itemKey));
  const matched = new Set(matches);
  current.forEach((segment, i) => {
    if (!matched.has(i)) removeUnmatched(ctx, parentId, segment);
  });
  let pos = 0;
  target.forEach((item, i) => {
    const segment = current[matches[i] ?? -1];
    if (segment === undefined) placeNew(ctx, parentId, pos, item);
    else if (segment.kind === "text") {
      segment.runs.forEach((run, k) => moveTo(ctx.builder, run.id, parentId, pos + k));
      diffText(ctx.builder, segment.runs, item as string);
      pos += segment.runs.length - 1;
    } else {
      moveTo(ctx.builder, segment.row.id, parentId, pos);
      reconcile(ctx, segment.row, item as ComponentNode);
    }
    pos += 1;
  });
}

/**
 * Synthesize reversible records that turn `table` into `target` (SPEC 11).
 * Tags change in place for the same identity, props are diffed per nested
 * field and list region, and child lists are aligned by identity keys.
 * This is a deterministic transition, not the author's actual history; a
 * differing root identity cannot be expressed and is rejected.
 */
export function diffToChanges(table: Table, target: ComponentNode, author: AuthoredBy): Change[] {
  const builder = new ChangeBuilder(table, author);
  const root = table.get(ROOT_ID);
  if (root === undefined) throw new ApplyError("missingNode", "table has no root");
  if (root.rootId !== target.id)
    throw new ApplyError("invalidTarget", "the document root identity cannot change");
  const ctx = { builder, targetIds: persistedIds(target) };
  reconcile(ctx, root, target);
  return [...builder.changes];
}
