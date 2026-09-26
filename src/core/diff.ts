import type { ComponentNode, ContentItem, JsonObject } from "./types.ts";
import type { Change } from "./change.ts";
import type { AuthoredBy, NodeSpec } from "./builder.ts";
import { ChangeBuilder } from "./builder.ts";
import { deepEqual } from "./normalize.ts";
import type { Table, TableNode } from "./table.ts";
import { ROOT_ID, TEXT_TAG, textOf } from "./table.ts";

/** Common-prefix/suffix splice over code points (SPEC 11: localizes edits; not globally minimal). */
export function minimalSplice(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } {
  const a = [...oldText];
  const b = [...newText];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix += 1;
  return {
    from: prefix,
    to: a.length - suffix,
    insert: b.slice(prefix, b.length - suffix).join(""),
  };
}

function diffProps(
  builder: ChangeBuilder,
  id: string,
  before: JsonObject,
  after: JsonObject,
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = after[key];
    const previous = before[key];
    if (next === undefined) {
      if (previous !== undefined) builder.set(id, key, undefined);
    } else if (previous === undefined || !deepEqual(previous, next)) builder.set(id, key, next);
  }
}

/** A table child list viewed as effective content: adjacent text runs form one segment. */
type Segment =
  | { readonly kind: "text"; readonly runs: readonly TableNode[] }
  | { readonly kind: "node"; readonly row: TableNode };

type Reader = (id: string) => TableNode | undefined;

function kids(read: Reader, parentId: string): TableNode[] {
  return (read(parentId)?.children ?? []).flatMap((id) => {
    const row = read(id);
    return row === undefined ? [] : [row];
  });
}

function segments(read: Reader, parentId: string): Segment[] {
  const out: Segment[] = [];
  for (const row of kids(read, parentId)) {
    const last = out[out.length - 1];
    if (row.tag !== TEXT_TAG) out.push({ kind: "node", row });
    else if (last?.kind === "text")
      out[out.length - 1] = { kind: "text", runs: [...last.runs, row] };
    else out.push({ kind: "text", runs: [row] });
  }
  return out.filter(
    (segment) => segment.kind === "node" || segment.runs.some((run) => textOf(run).length > 0),
  );
}

function sameShape(segment: Segment, item: ContentItem): boolean {
  if (typeof item === "string") return segment.kind === "text";
  if (segment.kind !== "node" || segment.row.tag !== item.tag) return false;
  return item.id !== undefined ? segment.row.id === item.id : !segment.row.persisted;
}

/**
 * Apply a splice of the segment's concatenated text onto its runs: insert at
 * the end of the replaced range (so it binds to the replaced content), then
 * delete the original range run by run.
 */
function diffText(builder: ChangeBuilder, runs: readonly TableNode[], target: string): void {
  const { from, to, insert } = minimalSplice(runs.map(textOf).join(""), target);
  let start = 0;
  const spans = runs.map((run) => {
    const span = { run, start, length: [...textOf(run)].length };
    start += span.length;
    return span;
  });
  const host = spans.find((span) => to >= span.start && to <= span.start + span.length);
  if (insert.length > 0 && host !== undefined)
    builder.textInsert(host.run.id, to - host.start, insert);
  for (const { run, start: offset, length } of spans) {
    const cutFrom = Math.max(from, offset) - offset;
    const cutTo = Math.min(to, offset + length) - offset;
    if (cutTo > cutFrom) builder.textDelete(run.id, cutFrom, cutTo - cutFrom);
  }
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

interface DiffContext {
  readonly builder: ChangeBuilder;
  /** Persisted ids present anywhere in the target: moved, never deleted and recreated. */
  readonly targetIds: ReadonlySet<string>;
}

function persistedIds(node: ComponentNode, into: Set<string> = new Set()): Set<string> {
  for (const item of node.content ?? []) {
    if (typeof item === "string") continue;
    if (item.id !== undefined) into.add(item.id);
    persistedIds(item, into);
  }
  return into;
}

function reusesExisting(item: ComponentNode, read: Reader): boolean {
  return (item.content ?? []).some(
    (child) =>
      typeof child !== "string" &&
      ((child.id !== undefined && read(child.id) !== undefined) || reusesExisting(child, read)),
  );
}

/** Place an existing persisted node at final child index `index` of `parentId`. */
function moveTo(builder: ChangeBuilder, id: string, parentId: string, index: number): void {
  const at = builder.position(id);
  if (at.parent !== parentId) builder.moveNode(id, parentId, index);
  else if (at.index !== index) builder.moveNode(id, parentId, at.index > index ? index : index + 1);
}

function replaceContent(ctx: DiffContext, parentId: string, target: readonly ContentItem[]): void {
  const { builder } = ctx;
  const read: Reader = (id) => builder.read(id);
  for (const row of kids(read, parentId))
    if (!(row.persisted && ctx.targetIds.has(row.id))) builder.deleteNode(row.id);
  target.forEach((item, index) => {
    const existing = typeof item === "string" || item.id === undefined ? undefined : read(item.id);
    if (typeof item === "string" || (existing === undefined && !reusesExisting(item, read))) {
      builder.insertNode(parentId, index, spec(item));
      return;
    }
    if (existing === undefined) {
      // A new node that contains persisted nodes still present elsewhere: create the shell,
      // then fill it so those nodes are moved in instead of recreated under the same id.
      const shell = builder.insertNode(parentId, index, {
        ...(spec(item) as NodeSpec),
        children: [],
      });
      diffContent(ctx, shell, item.content ?? []);
      return;
    }
    moveTo(builder, existing.id, parentId, index);
    diffProps(builder, existing.id, existing.props, item.props);
    diffContent(ctx, existing.id, item.content ?? []);
  });
}

function diffContent(ctx: DiffContext, parentId: string, target: readonly ContentItem[]): void {
  const current = segments((id) => ctx.builder.read(id), parentId);
  const alignable =
    current.length === target.length &&
    current.every((segment, i) => sameShape(segment, target[i] as ContentItem));
  if (!alignable) {
    replaceContent(ctx, parentId, target);
    return;
  }
  current.forEach((segment, i) => {
    const item = target[i] as ContentItem;
    if (segment.kind === "text") diffText(ctx.builder, segment.runs, item as string);
    else if (typeof item !== "string") {
      diffProps(ctx.builder, segment.row.id, segment.row.props, item.props);
      diffContent(ctx, segment.row.id, item.content ?? []);
    }
  });
}

/**
 * Synthesize reversible records that turn `table` into `target` (SPEC 11):
 * identity/shape-aligned where possible, whole replacement otherwise. This
 * is a deterministic transition, not the author's actual history.
 */
export function diffToChanges(table: Table, target: ComponentNode, author: AuthoredBy): Change[] {
  const builder = new ChangeBuilder(table, author);
  const root = table.get(ROOT_ID);
  if (root !== undefined) diffProps(builder, ROOT_ID, root.props, target.props);
  diffContent({ builder, targetIds: persistedIds(target) }, ROOT_ID, target.content ?? []);
  return [...builder.changes];
}
