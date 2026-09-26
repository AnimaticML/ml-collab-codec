import type { Change } from "./change.ts";
import { subtreeIds } from "./change.ts";
import type { JsonValue } from "./types.ts";
import { getAtPath } from "./json-path.ts";
import type { PropPath } from "./json-path.ts";
import { deepEqual } from "./normalize.ts";
import type { Table } from "./table.ts";
import { TEXT_TAG } from "./table.ts";

/**
 * What actually changed between two published snapshots (v3 §4.1).
 * `candidates` is the conservative set of nodes any internal step touched;
 * the other fields are verified net changes (before-first versus
 * after-last), so a known no-change input is not reported as dirty.
 */
export interface ChangeSummary {
  readonly candidates: readonly string[];
  readonly created: readonly string[];
  readonly deleted: readonly string[];
  readonly props: readonly { readonly node: string; readonly path: PropPath }[];
  readonly text: readonly string[];
  readonly children: readonly string[];
  readonly moved: readonly {
    readonly node: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
  /** Nodes whose type (tag) changed while keeping their identity. */
  readonly retagged: readonly {
    readonly node: string;
    readonly from: string;
    readonly to: string;
  }[];
}

export function isEmptySummary(summary: ChangeSummary): boolean {
  return (
    summary.created.length +
      summary.deleted.length +
      summary.props.length +
      summary.text.length +
      summary.children.length +
      summary.moved.length +
      summary.retagged.length ===
    0
  );
}

function touched(changes: readonly Change[]): { ids: Set<string>; paths: Map<string, PropPath[]> } {
  const ids = new Set<string>();
  const paths = new Map<string, PropPath[]>();
  for (const change of changes) {
    switch (change.kind) {
      case "nodeInsert":
      case "nodeDelete":
        ids.add(change.parent);
        subtreeIds(change.subtree, ids);
        break;
      case "nodeMove":
        ids.add(change.node).add(change.fromParent).add(change.toParent);
        break;
      case "split":
      case "merge":
        ids.add(change.node).add(change.other).add(change.parent);
        break;
      default:
        ids.add(change.node);
        if ("path" in change)
          paths.set(change.node, [...(paths.get(change.node) ?? []), change.path]);
    }
  }
  return { ids, paths };
}

function changedPaths(
  before: JsonValue,
  after: JsonValue,
  hinted: readonly PropPath[],
): PropPath[] {
  const tops = new Set<string>([...Object.keys(before as object), ...Object.keys(after as object)]);
  const result: PropPath[] = [];
  const unique = new Map(hinted.map((path) => [JSON.stringify(path), path]));
  for (const path of unique.values()) {
    const a = getAtPath(before as never, path);
    const b = getAtPath(after as never, path);
    if (a === undefined ? b !== undefined : b === undefined || !deepEqual(a, b)) result.push(path);
  }
  for (const key of tops) {
    if (result.some((path) => path[0] === key)) continue;
    const a = (before as Record<string, JsonValue>)[key];
    const b = (after as Record<string, JsonValue>)[key];
    if (a === undefined ? b !== undefined : b === undefined || !deepEqual(a, b)) result.push([key]);
  }
  return result;
}

/** Summarize the net effect of `changes` from `previous` to `next`. */
export function summarize(
  previous: Table,
  next: Table,
  changes: readonly Change[],
  fullResync = false,
): ChangeSummary {
  const { ids, paths } = touched(changes);
  // Documented coarse fallback: with no primitive mapping (restore/resync), every node is a candidate.
  if (fullResync) for (const id of [...previous.keys(), ...next.keys()]) ids.add(id);
  const summary = {
    candidates: [...ids],
    created: [] as string[],
    deleted: [] as string[],
    props: [] as { node: string; path: PropPath }[],
    text: [] as string[],
    children: [] as string[],
    moved: [] as { node: string; from: string | null; to: string | null }[],
    retagged: [] as { node: string; from: string; to: string }[],
  };
  for (const id of ids) {
    const before = previous.get(id);
    const after = next.get(id);
    if (before === after) continue;
    if (before === undefined) summary.created.push(id);
    else if (after === undefined) summary.deleted.push(id);
    else {
      if (before.tag !== after.tag)
        summary.retagged.push({ node: id, from: before.tag, to: after.tag });
      if (before.parentId !== after.parentId)
        summary.moved.push({ node: id, from: before.parentId, to: after.parentId });
      if (before.children.join("\u0000") !== after.children.join("\u0000"))
        summary.children.push(id);
      if (after.tag === TEXT_TAG) {
        if (before.props["value"] !== after.props["value"]) summary.text.push(id);
      } else {
        for (const path of changedPaths(before.props, after.props, paths.get(id) ?? []))
          summary.props.push({ node: id, path });
      }
    }
  }
  return summary;
}
