import type { JsonObject, JsonValue } from "./types.ts";
import { isJsonArray, isJsonObject } from "./types.ts";
import type { ChangeBuilder } from "./builder.ts";
import type { PropPath } from "./json-path.ts";
import { deepEqual } from "./normalize.ts";

/**
 * Property diff at the finest independently editable granularity: object
 * members are compared field by field (recursively), arrays by a positional
 * prefix/suffix splice with same-position object items diffed in place.
 * Arrays have no element identity, so equal values are never treated as
 * interchangeable instances beyond their positions. Keys are visited in
 * sorted order, so irrelevant key order never changes the transition.
 */
function commonEnds(
  a: readonly JsonValue[],
  b: readonly JsonValue[],
): { prefix: number; suffix: number } {
  let prefix = 0;
  while (
    prefix < a.length &&
    prefix < b.length &&
    deepEqual(a[prefix] as JsonValue, b[prefix] as JsonValue)
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    deepEqual(a[a.length - 1 - suffix] as JsonValue, b[b.length - 1 - suffix] as JsonValue)
  )
    suffix += 1;
  return { prefix, suffix };
}

function diffArray(
  builder: ChangeBuilder,
  node: string,
  path: PropPath,
  before: readonly JsonValue[],
  after: readonly JsonValue[],
): void {
  const { prefix, suffix } = commonEnds(before, after);
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const inPlace =
    oldMiddle.length === newMiddle.length &&
    oldMiddle.every((item, i) => isJsonObject(item) && isJsonObject(newMiddle[i]));
  if (inPlace) {
    oldMiddle.forEach((item, i) =>
      diffValue(builder, node, [...path, prefix + i], item, newMiddle[i]),
    );
    return;
  }
  if (oldMiddle.length > 0) builder.arrayDelete(node, path, prefix, oldMiddle.length);
  if (newMiddle.length > 0) builder.arrayInsert(node, path, prefix, newMiddle);
}

function diffValue(
  builder: ChangeBuilder,
  node: string,
  path: PropPath,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): void {
  if (before !== undefined && after !== undefined && deepEqual(before, after)) return;
  if (isJsonObject(before) && isJsonObject(after) && path.length > 0) {
    diffObject(builder, node, path, before, after);
    return;
  }
  if (isJsonArray(before) && isJsonArray(after)) {
    diffArray(builder, node, path, before, after);
    return;
  }
  builder.set(node, path, after);
}

function diffObject(
  builder: ChangeBuilder,
  node: string,
  path: PropPath,
  before: JsonObject,
  after: JsonObject,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) diffValue(builder, node, [...path, key], before[key], after[key]);
}

/** Diff a node's top-level props (each property is independently editable). */
export function diffProps(
  builder: ChangeBuilder,
  node: string,
  before: JsonObject,
  after: JsonObject,
): void {
  diffObject(builder, node, [], before, after);
}
