import type { JsonValue } from "./types.ts";
import type { Change, ChangeOf } from "./change.ts";
import { landingIndex } from "./change.ts";
import { deepEqual } from "./normalize.ts";
import type { PropPath } from "./json-path.ts";
import { isPathPrefix, samePath } from "./json-path.ts";
import { descendingRuns, mapElement, mapGap, mapRange } from "./seq.ts";
import type { ListStep } from "./seq.ts";
import type { TransformResult } from "./transform-steps.ts";
import { arrayStep, conflict, originTie } from "./transform-steps.ts";

type PropChange = ChangeOf<"set" | "delta" | "arrayInsert" | "arrayDelete" | "arrayMove">;

function valueWritePath(b: Change): PropPath | null {
  return b.kind === "set" || b.kind === "delta" ? b.path : null;
}

function arrayPath(b: Change): PropPath | null {
  return b.kind === "arrayInsert" || b.kind === "arrayDelete" || b.kind === "arrayMove"
    ? b.path
    : null;
}

/**
 * Re-index `path` when a concurrent array primitive at `listPath` changes
 * the element that `path` descends into. Returns null when that element
 * was removed (a delete/edit conflict, never a search for an equal value).
 */
function remapThroughArray(path: PropPath, listPath: PropPath, step: ListStep): PropPath | null {
  const index = path[listPath.length];
  if (typeof index !== "number") return path;
  const mapped = mapElement(index, step);
  if (mapped === null) return null;
  return path.map((segment, i) => (i === listPath.length ? mapped : segment));
}

function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return a === undefined || b === undefined ? a === b : deepEqual(a, b);
}

/** Transform a value write (set/delta) against a concurrent change on the same node. */
function transformValueWrite(a: ChangeOf<"set" | "delta">, b: Change): TransformResult {
  const written = valueWritePath(b);
  if (written !== null) {
    if (samePath(written, a.path)) {
      if (a.kind === "delta" && b.kind === "delta") return [a];
      if (a.kind === "set" && b.kind === "set" && sameValue(a.after, b.after)) return [];
      return conflict("concurrentWrite", "concurrent writes to the same field");
    }
    if (isPathPrefix(written, a.path) || isPathPrefix(a.path, written))
      return conflict("concurrentWrite", "a concurrent write replaced or edited inside this value");
    return [a];
  }
  const list = arrayPath(b);
  if (list === null) return [a];
  if (isPathPrefix(a.path, list))
    return conflict("concurrentWrite", "value contains a concurrently edited array");
  if (!isPathPrefix(list, a.path)) return [a];
  const step = arrayStep(b, a.node, list);
  const path = step === null ? a.path : remapThroughArray(a.path, list, step);
  if (path === null) return conflict("deleted", "the array occurrence was concurrently removed");
  return [{ ...a, path }];
}

function transformSameList(
  a: ChangeOf<"arrayInsert" | "arrayDelete" | "arrayMove">,
  b: Change,
  step: ListStep,
): TransformResult {
  if (a.kind === "arrayInsert") {
    return [{ ...a, index: mapGap(a.index, step, originTie(a.origin, JSON.stringify(a.values))) }];
  }
  if (a.kind === "arrayDelete") {
    const { survivors, overlap } = mapRange(a.index, a.values, step);
    if (b.kind === "arrayDelete") {
      for (const { index, item } of overlap)
        if (!deepEqual(item, b.values[index - b.index] as JsonValue))
          return conflict(
            "payloadMismatch",
            "overlapping removals disagree on the removed occurrence",
          );
    }
    return descendingRuns(survivors).map((run) => ({ ...a, index: run.index, values: run.items }));
  }
  const from = mapElement(a.from, step);
  if (from === null) return conflict("deleted", "the moved occurrence was concurrently removed");
  if (b.kind === "arrayMove" && b.from === a.from) {
    return landingIndex(a.from, a.gap) === landingIndex(b.from, b.gap)
      ? []
      : conflict("concurrentWrite", "concurrent moves of the same occurrence");
  }
  const gap = mapGap(a.gap, step, originTie(a.origin, `${a.from}`));
  return gap === from || gap === from + 1 ? [] : [{ ...a, from, gap }];
}

/** Transform an array primitive against a concurrent change on the same node. */
function transformArray(
  a: ChangeOf<"arrayInsert" | "arrayDelete" | "arrayMove">,
  b: Change,
): TransformResult {
  const written = valueWritePath(b);
  if (written !== null) {
    if (isPathPrefix(written, a.path))
      return conflict("concurrentWrite", "the array was concurrently replaced");
    return touchesRemovedElement(a, written)
      ? conflict("concurrentWrite", "removal of a concurrently edited occurrence")
      : [a];
  }
  const list = arrayPath(b);
  if (list === null) return [a];
  if (samePath(list, a.path)) {
    const step = arrayStep(b, a.node, list);
    return step === null ? [a] : transformSameList(a, b, step);
  }
  if (isPathPrefix(list, a.path)) {
    const step = arrayStep(b, a.node, list);
    const path = step === null ? a.path : remapThroughArray(a.path, list, step);
    return path === null
      ? conflict("deleted", "the containing occurrence was concurrently removed")
      : [{ ...a, path }];
  }
  return touchesRemovedElement(a, list)
    ? conflict("concurrentWrite", "removal of a concurrently edited occurrence")
    : [a];
}

/** True when `a` removes the element of its array that `innerPath` descends into. */
function touchesRemovedElement(
  a: ChangeOf<"arrayInsert" | "arrayDelete" | "arrayMove">,
  innerPath: PropPath,
): boolean {
  if (
    a.kind !== "arrayDelete" ||
    !isPathPrefix(a.path, innerPath) ||
    innerPath.length === a.path.length
  )
    return false;
  const index = innerPath[a.path.length];
  return typeof index === "number" && index >= a.index && index < a.index + a.values.length;
}

export function transformPropChange(a: PropChange, b: Change): TransformResult {
  if (!("node" in b) || b.node !== a.node) return [a];
  return a.kind === "set" || a.kind === "delta" ? transformValueWrite(a, b) : transformArray(a, b);
}
