import type { Change, Origin } from "./change.ts";
import { codePointLength, compareOrigin } from "./change.ts";
import type { PropPath } from "./json-path.ts";
import { samePath } from "./json-path.ts";
import type { ListStep, TieRule } from "./seq.ts";

export type TransformConflictCode = "deleted" | "concurrentWrite" | "structure" | "payloadMismatch";

/** The transformed (newer) change cannot be expressed after the accepted one (v3 §5.7). */
export interface TransformConflict {
  readonly conflict: TransformConflictCode;
  readonly detail: string;
}

export type TransformResult = readonly Change[] | TransformConflict;

export function conflict(code: TransformConflictCode, detail: string): TransformConflict {
  return { conflict: code, detail };
}

export function isConflict<T extends object>(
  result: T | TransformConflict,
): result is TransformConflict {
  return !Array.isArray(result) && "conflict" in result;
}

/** The step a change applies to text run `node`, if any (split/merge are handled by callers). */
export function textStep(b: Change, node: string): ListStep | null {
  if (b.kind === "textInsert" && b.node === node)
    return {
      t: "ins",
      gap: b.offset,
      count: codePointLength(b.text),
      origin: b.origin,
      payload: b.text,
    };
  if (b.kind === "textDelete" && b.node === node)
    return { t: "del", index: b.offset, count: codePointLength(b.text) };
  return null;
}

export function arrayStep(b: Change, node: string, path: PropPath): ListStep | null {
  if (b.kind !== "arrayInsert" && b.kind !== "arrayDelete" && b.kind !== "arrayMove") return null;
  if (b.node !== node || !samePath(b.path, path)) return null;
  if (b.kind === "arrayInsert")
    return {
      t: "ins",
      gap: b.index,
      count: b.values.length,
      origin: b.origin,
      payload: JSON.stringify(b.values),
    };
  if (b.kind === "arrayDelete") return { t: "del", index: b.index, count: b.values.length };
  return { t: "move", from: b.from, gap: b.gap, origin: b.origin, payload: `${b.from}` };
}

/** The step a change applies to the child list of `parent`, if any. */
export function childStep(b: Change, parent: string): ListStep | null {
  switch (b.kind) {
    case "nodeInsert":
      return b.parent === parent
        ? { t: "ins", gap: b.index, count: 1, origin: b.origin, payload: b.subtree.id }
        : null;
    case "nodeDelete":
      return b.parent === parent ? { t: "del", index: b.index, count: 1 } : null;
    case "nodeMove":
      if (b.fromParent === parent && b.toParent === parent)
        return { t: "move", from: b.fromIndex, gap: b.gap, origin: b.origin, payload: b.node };
      if (b.fromParent === parent) return { t: "del", index: b.fromIndex, count: 1 };
      if (b.toParent === parent)
        return { t: "ins", gap: b.gap, count: 1, origin: b.origin, payload: b.node };
      return null;
    case "split":
      return b.parent === parent
        ? { t: "ins", gap: b.index + 1, count: 1, origin: b.origin, glue: true, payload: b.other }
        : null;
    case "merge":
      return b.parent === parent ? { t: "del", index: b.index + 1, count: 1 } : null;
    default:
      return null;
  }
}

/** §5.6 tie rule for an insertion carrying `origin` and `payload`: the lower stable origin goes first. */
export function originTie(origin: Origin, payload: string): TieRule {
  return (step) => {
    if (step.t === "ins" && step.glue === true) return false;
    const order = compareOrigin(origin, step.origin);
    if (order !== 0) return order < 0;
    return payload < step.payload;
  };
}

/** A boundary that belongs to the text on its left (split points, merge boundaries): inserted text at the boundary stays left. */
export const afterTie: TieRule = () => false;
