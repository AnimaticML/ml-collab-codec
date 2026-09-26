import type { Change } from "./change.ts";
import { destroyedNodes, requiredNodes } from "./change.ts";
import { transformNodeChange } from "./transform-nodes.ts";
import { transformPropChange } from "./transform-props.ts";
import { transformTextChange } from "./transform-text.ts";
import type { TransformConflict, TransformResult } from "./transform-steps.ts";
import { conflict, isConflict } from "./transform-steps.ts";

export type { TransformConflict, TransformConflictCode } from "./transform-steps.ts";
export { isConflict } from "./transform-steps.ts";

/**
 * Practical bound on transform expansion. A deletion expands by at most one
 * piece per concurrent insertion it spans, so |A'| ≤ |A|·(|B|+1); exceeding
 * the bound is an explicit error, never silent truncation (v3 §5.3).
 */
const MAX_TRANSFORM_PRIMITIVES = 10_000;

export class TransformLimitError extends Error {}

function overlaps(ids: readonly string[], destroyed: ReadonlySet<string>): boolean {
  return ids.some((id) => destroyed.has(id));
}

/** Delete/edit policy (SPEC 8.2): a change that needs a concurrently destroyed node, or destroys a concurrently edited one, is incompatible. */
function existenceCheck(a: Change, b: Change): TransformResult | null {
  if (a.kind === "nodeDelete" && b.kind === "nodeDelete" && a.subtree.id === b.subtree.id)
    return [];
  if (overlaps(requiredNodes(a), destroyedNodes(b)))
    return conflict("deleted", "a required node was concurrently deleted");
  if (overlaps(requiredNodes(b), destroyedNodes(a)))
    return conflict("deleted", "the deletion would remove concurrently edited content");
  return null;
}

/** `a` rewritten to apply after concurrent `b` (both formed in the same context). May expand. */
function transformChange(a: Change, b: Change): TransformResult {
  const existence = existenceCheck(a, b);
  if (existence !== null) return existence;
  switch (a.kind) {
    case "set":
    case "delta":
    case "arrayInsert":
    case "arrayDelete":
    case "arrayMove":
      return transformPropChange(a, b);
    case "textInsert":
    case "textDelete":
    case "split":
    case "merge":
      return transformTextChange(a, b);
    case "nodeInsert":
    case "nodeDelete":
    case "nodeMove":
      return transformNodeChange(a, b);
  }
}

export interface Transformed {
  /** A rewritten to follow B. */
  readonly a: readonly Change[];
  /** B rewritten to follow A. */
  readonly b: readonly Change[];
}

/**
 * Paired inclusion transformation of two concurrent sequential composites:
 * apply(apply(S, A), result.b) ≡ apply(apply(S, B), result.a). A conflict
 * means A (the newer or pending side) cannot follow B; B is never discarded.
 */
export function transformPair(
  a: readonly Change[],
  b: readonly Change[],
): Transformed | TransformConflict {
  if (a.length === 0 || b.length === 0) return { a, b };
  if (a.length === 1 && b.length === 1) return pairOne(a[0] as Change, b[0] as Change);
  if (a.length > 1) {
    const head = transformPair(a.slice(0, 1), b);
    if (isConflict(head)) return head;
    const rest = transformPair(a.slice(1), head.b);
    if (isConflict(rest)) return rest;
    return bounded({ a: [...head.a, ...rest.a], b: rest.b });
  }
  const first = transformPair(a, b.slice(0, 1));
  if (isConflict(first)) return first;
  const rest = transformPair(first.a, b.slice(1));
  if (isConflict(rest)) return rest;
  return bounded({ a: rest.a, b: [...first.b, ...rest.b] });
}

function pairOne(a: Change, b: Change): Transformed | TransformConflict {
  const aAfter = transformChange(a, b);
  if (isConflict(aAfter)) return aAfter;
  const bAfter = transformChange(b, a);
  if (isConflict(bAfter)) return bAfter;
  return { a: aAfter, b: bAfter };
}

function bounded(result: Transformed): Transformed {
  if (result.a.length + result.b.length > MAX_TRANSFORM_PRIMITIVES)
    throw new TransformLimitError(
      `transform expanded beyond ${MAX_TRANSFORM_PRIMITIVES} primitives`,
    );
  return result;
}

/** Rebase `a` over accepted `b` (only the A side of the pair). */
export function rebase(
  a: readonly Change[],
  b: readonly Change[],
): readonly Change[] | TransformConflict {
  const result = transformPair(a, b);
  return isConflict(result) ? result : result.a;
}
