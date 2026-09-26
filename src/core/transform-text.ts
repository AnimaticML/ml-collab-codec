import type { Change, ChangeOf } from "./change.ts";
import { compareOrigin } from "./change.ts";
import { descendingRuns, mapElement, mapGap, mapRange } from "./seq.ts";
import type { TransformResult } from "./transform-steps.ts";
import { afterTie, childStep, conflict, originTie, textStep } from "./transform-steps.ts";

type TextEdit = ChangeOf<"textInsert" | "textDelete">;
type RunChange = ChangeOf<"split" | "merge">;

/**
 * Where an original code point of run `node` lives after a concurrent
 * split/merge: split moves its tail to the new run; merge appends the
 * absorbed run to the kept run at the recorded boundary.
 */
function relocate(
  node: string,
  offset: number,
  b: Change,
  leftAtBoundary: boolean,
): { node: string; offset: number } {
  if (b.kind === "split" && b.node === node) {
    const staysLeft = offset < b.offset || (offset === b.offset && leftAtBoundary);
    return staysLeft ? { node, offset } : { node: b.other, offset: offset - b.offset };
  }
  if (b.kind === "merge" && b.other === node) return { node: b.node, offset: offset + b.offset };
  return { node, offset };
}

function transformInsert(a: ChangeOf<"textInsert">, b: Change): TransformResult {
  const step = textStep(b, a.node);
  if (step !== null) return [{ ...a, offset: mapGap(a.offset, step, originTie(a.origin, a.text)) }];
  return [{ ...a, ...relocate(a.node, a.offset, b, true) }];
}

function transformDelete(a: ChangeOf<"textDelete">, b: Change): TransformResult {
  const chars = [...a.text];
  const step = textStep(b, a.node);
  if (step !== null) {
    const { survivors, overlap } = mapRange(a.offset, chars, step);
    if (b.kind === "textDelete") {
      const removed = [...b.text];
      if (overlap.some(({ index, item }) => removed[index - b.offset] !== item))
        return conflict("payloadMismatch", "overlapping deletions disagree on the removed text");
    }
    return descendingRuns(survivors).map((run) => ({
      ...a,
      offset: run.index,
      text: run.items.join(""),
    }));
  }
  if (
    b.kind === "split" &&
    b.node === a.node &&
    a.offset < b.offset &&
    a.offset + chars.length > b.offset
  ) {
    const cut = b.offset - a.offset;
    return [
      { ...a, node: b.other, offset: 0, text: chars.slice(cut).join("") },
      { ...a, text: chars.slice(0, cut).join("") },
    ];
  }
  return [{ ...a, ...relocate(a.node, a.offset, b, false) }];
}

/** Two splits of one run at the same point: the lower origin is the outer cut, the other splits its empty continuation. */
function splitAgainstSplit(a: ChangeOf<"split">, b: ChangeOf<"split">): TransformResult {
  const outer =
    a.offset < b.offset || (a.offset === b.offset && compareOrigin(a.origin, b.origin) < 0);
  return outer ? [a] : [{ ...a, node: b.other, offset: a.offset - b.offset, index: a.index + 1 }];
}

function transformSplit(a: ChangeOf<"split">, b: Change): TransformResult {
  if (b.kind === "nodeMove" && b.node === a.node)
    return conflict("structure", "the split run was concurrently moved");
  if (b.kind === "split" && b.node === a.node) return splitAgainstSplit(a, b);
  const step = textStep(b, a.node);
  if (step !== null) return [{ ...a, offset: mapGap(a.offset, step, afterTie) }];
  if (b.kind === "merge" && b.other === a.node)
    return [{ ...a, node: b.node, offset: a.offset + b.offset, index: b.index }];
  return mapRunIndex(a, b);
}

function transformMerge(a: ChangeOf<"merge">, b: Change): TransformResult {
  if (b.kind === "nodeMove" && (b.node === a.node || b.node === a.other))
    return conflict("structure", "a merged run was concurrently moved");
  if (b.kind === "merge" && b.node === a.node && b.other === a.other) return [];
  const step = textStep(b, a.node);
  if (step !== null) return [{ ...a, offset: mapGap(a.offset, step, afterTie) }];
  if (b.kind === "split" && b.node === a.node)
    return [{ ...a, node: b.other, offset: a.offset - b.offset, index: a.index + 1 }];
  if (b.kind === "merge" && b.other === a.node)
    return [{ ...a, node: b.node, offset: a.offset + b.offset, index: b.index }];
  if (b.kind === "merge" && b.node === a.other) return [a];
  return mapRunIndex(a, b);
}

/** Re-index a split/merge anchor run among its parent's children. */
function mapRunIndex(a: RunChange, b: Change): TransformResult {
  const step = childStep(b, a.parent);
  if (step === null) return [a];
  const index = mapElement(a.index, step);
  if (index === null) return conflict("deleted", "the run was concurrently removed");
  if (a.kind === "merge" && mapElement(a.index + 1, step) !== index + 1)
    return conflict("structure", "the merged runs are no longer adjacent");
  return [{ ...a, index }];
}

export function transformTextChange(a: TextEdit | RunChange, b: Change): TransformResult {
  switch (a.kind) {
    case "textInsert":
      return transformInsert(a, b);
    case "textDelete":
      return transformDelete(a, b);
    case "split":
      return transformSplit(a, b);
    case "merge":
      return transformMerge(a, b);
  }
}
