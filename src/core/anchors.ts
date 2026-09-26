import type { Change } from "./change.ts";
import { codePointLength, subtreeIds } from "./change.ts";
import { canonicalJson } from "./change-codec.ts";
import type { PropPath } from "./json-path.ts";
import { getAtPath, isPathPrefix, samePath } from "./json-path.ts";
import { mapElement } from "./seq.ts";
import { arrayStep } from "./transform-steps.ts";
import { readSubtree } from "./apply-structure.ts";
import { StagedTable } from "./staging.ts";
import type { Table } from "./table.ts";
import { textOf } from "./table.ts";

/** A text segment of original content: code points [from, to) of run `node`. */
export interface TextSegment {
  readonly node: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Anchors carry their own addressing semantics:
 * - `node`: a structural identity; a deleted node is removed, never re-found.
 * - `point`: a caret; `before` binds to the preceding character (text
 *   inserted exactly at the point goes after it), `after` to the following.
 *   A deletion around it collapses it to the deletion boundary.
 * - `range`: original content only; concurrent insertions inside are
 *   excluded, so a range may become several segments.
 * - `occurrence`: one array element at a concrete index in a known context.
 */
export type Anchor =
  | { readonly kind: "node"; readonly node: string }
  | {
      readonly kind: "point";
      readonly node: string;
      readonly offset: number;
      readonly affinity: "before" | "after";
    }
  | { readonly kind: "range"; readonly segments: readonly TextSegment[] }
  | {
      readonly kind: "occurrence";
      readonly node: string;
      readonly path: PropPath;
      readonly index: number;
    };

export type AnchorResult =
  | { readonly status: "mapped"; readonly anchor: Anchor }
  | { readonly status: "removed"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

function removedNodes(change: Change): ReadonlySet<string> {
  return change.kind === "nodeDelete" ? subtreeIds(change.subtree) : new Set();
}

function mapPoint(anchor: Extract<Anchor, { kind: "point" }>, change: Change): AnchorResult {
  const { node, offset } = anchor;
  if (removedNodes(change).has(node))
    return { status: "removed", reason: "the text run was deleted" };
  const after = anchor.affinity === "after";
  let next = { node, offset };
  if (change.kind === "textInsert" && change.node === node) {
    const moves = offset > change.offset || (offset === change.offset && after);
    next = { node, offset: moves ? offset + codePointLength(change.text) : offset };
  } else if (change.kind === "textDelete" && change.node === node) {
    const end = change.offset + codePointLength(change.text);
    next = {
      node,
      offset:
        offset <= change.offset
          ? offset
          : offset >= end
            ? offset - (end - change.offset)
            : change.offset,
    };
  } else if (change.kind === "split" && change.node === node) {
    const moves = offset > change.offset || (offset === change.offset && after);
    next = moves ? { node: change.other, offset: offset - change.offset } : next;
  } else if (change.kind === "merge" && change.other === node) {
    next = { node: change.node, offset: offset + change.offset };
  }
  return { status: "mapped", anchor: { ...anchor, ...next } };
}

function mapSegment(segment: TextSegment, change: Change): TextSegment[] {
  const { node, from, to } = segment;
  if (removedNodes(change).has(node)) return [];
  if (change.kind === "textInsert" && change.node === node) {
    const n = codePointLength(change.text);
    if (change.offset <= from) return [{ node, from: from + n, to: to + n }];
    if (change.offset >= to) return [segment];
    return [
      { node, from, to: change.offset },
      { node, from: change.offset + n, to: to + n },
    ];
  }
  if (change.kind === "textDelete" && change.node === node) {
    const s = change.offset;
    const e = s + codePointLength(change.text);
    const clip = (p: number): number => (p <= s ? p : p >= e ? p - (e - s) : s);
    return [{ node, from: clip(from), to: clip(to) }];
  }
  if (change.kind === "split" && change.node === node) {
    const k = change.offset;
    const left = from < k ? [{ node, from, to: Math.min(to, k) }] : [];
    const right = to > k ? [{ node: change.other, from: Math.max(from, k) - k, to: to - k }] : [];
    return [...left, ...right];
  }
  if (change.kind === "merge" && change.other === node)
    return [{ node: change.node, from: from + change.offset, to: to + change.offset }];
  return [segment];
}

function mapOccurrence(
  anchor: Extract<Anchor, { kind: "occurrence" }>,
  change: Change,
): AnchorResult {
  if (removedNodes(change).has(anchor.node))
    return { status: "removed", reason: "the owning node was deleted" };
  if (!("node" in change) || change.node !== anchor.node) return { status: "mapped", anchor };
  if (change.kind === "set" && isPathPrefix(change.path, [...anchor.path, anchor.index]))
    return { status: "removed", reason: "the occurrence was replaced" };
  if (change.kind !== "arrayInsert" && change.kind !== "arrayDelete" && change.kind !== "arrayMove")
    return { status: "mapped", anchor };
  const step = arrayStep(change, change.node, change.path);
  if (step === null) return { status: "mapped", anchor };
  if (samePath(change.path, anchor.path)) {
    const index = mapElement(anchor.index, step);
    return index === null
      ? { status: "removed", reason: "the occurrence was deleted" }
      : { status: "mapped", anchor: { ...anchor, index } };
  }
  if (!isPathPrefix(change.path, anchor.path) || change.path.length >= anchor.path.length)
    return { status: "mapped", anchor };
  const outer = anchor.path[change.path.length];
  if (typeof outer !== "number") return { status: "mapped", anchor };
  const index = mapElement(outer, step);
  if (index === null) return { status: "removed", reason: "the containing occurrence was deleted" };
  return {
    status: "mapped",
    anchor: {
      ...anchor,
      path: anchor.path.map((seg, i) => (i === change.path.length ? index : seg)),
    },
  };
}

/** Map an anchor through changes applied after the anchor's context, in order. */
export function mapAnchor(anchor: Anchor, changes: readonly Change[]): AnchorResult {
  let current: Anchor = anchor;
  for (const change of changes) {
    let result: AnchorResult;
    if (current.kind === "node") {
      result =
        removedNodes(change).has(current.node) ||
        (change.kind === "merge" && change.other === current.node)
          ? { status: "removed", reason: "the node was deleted" }
          : { status: "mapped", anchor: current };
    } else if (current.kind === "point") result = mapPoint(current, change);
    else if (current.kind === "occurrence") result = mapOccurrence(current, change);
    else {
      const segments = current.segments
        .flatMap((segment) => mapSegment(segment, change))
        .filter((segment) => segment.to > segment.from);
      result =
        segments.length === 0
          ? { status: "removed", reason: "all original content was deleted" }
          : { status: "mapped", anchor: { kind: "range", segments } };
    }
    if (result.status !== "mapped") return result;
    current = result.anchor;
  }
  return { status: "mapped", anchor: current };
}

/** Map from a known revision using a transition source; missing history is explicit, never a guess. */
export function mapAnchorFrom(
  anchor: Anchor,
  revision: number,
  source: {
    transitionsSince(
      revision: number,
    ): readonly { readonly changes: readonly Change[] }[] | undefined;
  },
): AnchorResult {
  const transitions = source.transitionsSince(revision);
  if (transitions === undefined)
    return { status: "unavailable", reason: "the anchor's base context is no longer retained" };
  return mapAnchor(
    anchor,
    transitions.flatMap((transition) => transition.changes),
  );
}

/** Content fingerprint for a read-content/version precondition (address survival ≠ freshness). */
export function anchoredContent(table: Table, anchor: Anchor): string | undefined {
  switch (anchor.kind) {
    case "node":
      return table.has(anchor.node)
        ? canonicalJson(readSubtree(new StagedTable(table), anchor.node))
        : undefined;
    case "point":
      return table.has(anchor.node) ? "" : undefined;
    case "range":
      return anchor.segments
        .map((s) => [...textOf(table.get(s.node))].slice(s.from, s.to).join(""))
        .join("\u0000");
    case "occurrence": {
      const value = getAtPath(table.get(anchor.node)?.props ?? {}, [...anchor.path, anchor.index]);
      return value === undefined ? undefined : canonicalJson(value);
    }
  }
}
