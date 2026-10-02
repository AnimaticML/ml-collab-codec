import type { JsonValue } from "./types.ts";
import type { Change, ChangeOf } from "./change.ts";
import { codePointLength, compareOrigin } from "./change.ts";
import { deepEqual } from "./normalize.ts";
import { samePath } from "./json-path.ts";

function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return a === undefined || b === undefined ? a === b : deepEqual(a, b);
}

/**
 * Simplify two adjacent primitives (x then y) when the combined record is
 * provably equivalent for application, inversion, and placement. Returns
 * `undefined` when no safe simplification applies (keep both), or an array
 * (possibly empty for an exact net-zero pair) that replaces them. A merged
 * record keeps the lower (earlier) origin of the two, so the result does not
 * depend on composition order: a group's inverses composed newest first
 * equal the inverse of its composed changes. Both parts share a replica, so
 * placement against any foreign insertion is unchanged.
 */
function simplifyPair(x: Change, y: Change): Change[] | undefined {
  if (x.origin.replica !== y.origin.replica) return undefined;
  const merged = mergePair(x, y);
  if (merged === undefined || merged.length === 0) return merged;
  const origin = compareOrigin(x.origin, y.origin) <= 0 ? x.origin : y.origin;
  return merged.map((change) => ({ ...change, origin }));
}

function mergePair(x: Change, y: Change): Change[] | undefined {
  if (x.kind === "textInsert" && y.kind === "textInsert") return typing(x, y);
  if (x.kind === "textDelete" && y.kind === "textDelete") return deleting(x, y);
  if (x.kind === "set" && y.kind === "set") return setChain(x, y);
  if (x.kind === "delta" && y.kind === "delta") return deltaChain(x, y);
  return undefined;
}

/** Consecutive typing: y appends right after x's text, or lands right before it (the inverse of a forward-delete run). */
function typing(x: ChangeOf<"textInsert">, y: ChangeOf<"textInsert">): Change[] | undefined {
  if (x.node !== y.node) return undefined;
  if (y.offset === x.offset + codePointLength(x.text)) return [{ ...x, text: x.text + y.text }];
  if (y.offset === x.offset) return [{ ...x, text: y.text + x.text }];
  return undefined;
}

/** Same-direction adjacent deletion: backspace (y ends where x began) or forward delete (same offset). */
function deleting(x: ChangeOf<"textDelete">, y: ChangeOf<"textDelete">): Change[] | undefined {
  if (x.node !== y.node) return undefined;
  if (y.offset + codePointLength(y.text) === x.offset)
    return [{ ...x, offset: y.offset, text: y.text + x.text }];
  if (y.offset === x.offset) return [{ ...x, text: x.text + y.text }];
  return undefined;
}

/** Same-field assignment chain 10→11, 11→14 becomes 10→14; an exact round trip cancels. */
function setChain(x: ChangeOf<"set">, y: ChangeOf<"set">): Change[] | undefined {
  if (x.node !== y.node || !samePath(x.path, y.path) || !sameValue(x.after, y.before))
    return undefined;
  if (sameValue(x.before, y.after)) return [];
  const { after: _dropped, ...rest } = x;
  return [{ ...rest, ...(y.after === undefined ? {} : { after: y.after }) }];
}

/** Additive composition stays inside the safe-integer profile or is left uncomposed. */
function deltaChain(x: ChangeOf<"delta">, y: ChangeOf<"delta">): Change[] | undefined {
  if (x.node !== y.node || !samePath(x.path, y.path)) return undefined;
  const by = x.by + y.by;
  if (!Number.isSafeInteger(by)) return undefined;
  return by === 0 ? [] : [{ ...x, by }];
}

/**
 * Sequential composition (v3 §6.3): apply(S, compose(A, B)) ≡ apply(apply(S, A), B)
 * and its inverse is derivable from the result alone. Unsupported pairs stay
 * as ordered reversible parts; only the tested simple cases are compressed.
 */
export function compose(a: readonly Change[], b: readonly Change[]): Change[] {
  const result: Change[] = [...a];
  for (const next of b) {
    const last = result[result.length - 1];
    const simplified = last === undefined ? undefined : simplifyPair(last, next);
    if (simplified === undefined) result.push(next);
    else result.splice(result.length - 1, 1, ...simplified);
  }
  return result;
}
