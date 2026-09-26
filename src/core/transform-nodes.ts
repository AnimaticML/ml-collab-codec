import type { Change, ChangeOf } from "./change.ts";
import { landingIndex } from "./change.ts";
import { mapElement, mapGap } from "./seq.ts";
import type { TransformResult } from "./transform-steps.ts";
import { childStep, conflict, originTie } from "./transform-steps.ts";

type NodeChange = ChangeOf<"nodeInsert" | "nodeDelete" | "nodeMove">;

/** Adjacent runs of a concurrent merge: nothing may be placed between them. */
function splitsMergedRuns(b: Change, parent: string, gap: number): boolean {
  return b.kind === "merge" && b.parent === parent && gap === b.index + 1;
}

function transformInsert(a: ChangeOf<"nodeInsert">, b: Change): TransformResult {
  if (splitsMergedRuns(b, a.parent, a.index))
    return conflict("structure", "insertion between concurrently merged runs");
  const step = childStep(b, a.parent);
  if (step === null) return [a];
  return [{ ...a, index: mapGap(a.index, step, originTie(a.origin, a.subtree.id)) }];
}

function transformDelete(a: ChangeOf<"nodeDelete">, b: Change): TransformResult {
  if (b.kind === "nodeMove" && b.node === a.subtree.id)
    return conflict("concurrentWrite", "the deleted node was concurrently moved");
  const step = childStep(b, a.parent);
  if (step === null) return [a];
  const index = mapElement(a.index, step);
  return index === null
    ? conflict("deleted", "the node was concurrently removed")
    : [{ ...a, index }];
}

function sameDestination(a: ChangeOf<"nodeMove">, b: ChangeOf<"nodeMove">): boolean {
  if (a.toParent !== b.toParent) return false;
  const landA = a.fromParent === a.toParent ? landingIndex(a.fromIndex, a.gap) : a.gap;
  const landB = b.fromParent === b.toParent ? landingIndex(b.fromIndex, b.gap) : b.gap;
  return landA === landB;
}

function transformMove(a: ChangeOf<"nodeMove">, b: Change): TransformResult {
  if (b.kind === "nodeMove" && b.node === a.node)
    return sameDestination(a, b)
      ? []
      : conflict("concurrentWrite", "concurrent moves of the same node");
  if ((b.kind === "split" || b.kind === "merge") && (b.node === a.node || b.other === a.node))
    return conflict("structure", "the moved run was concurrently split or merged");
  if (splitsMergedRuns(b, a.toParent, a.gap))
    return conflict("structure", "move between concurrently merged runs");
  const tie = originTie(a.origin, a.node);
  const fromStep = childStep(b, a.fromParent);
  const fromIndex = fromStep === null ? a.fromIndex : mapElement(a.fromIndex, fromStep);
  if (fromIndex === null) return conflict("deleted", "the moved node was concurrently removed");
  const toStep = childStep(b, a.toParent);
  const gap = toStep === null ? a.gap : mapGap(a.gap, toStep, tie);
  if (a.fromParent === a.toParent && (gap === fromIndex || gap === fromIndex + 1)) return [];
  return [{ ...a, fromIndex, gap }];
}

export function transformNodeChange(a: NodeChange, b: Change): TransformResult {
  switch (a.kind) {
    case "nodeInsert":
      return transformInsert(a, b);
    case "nodeDelete":
      return transformDelete(a, b);
    case "nodeMove":
      return transformMove(a, b);
  }
}
