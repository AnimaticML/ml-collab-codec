import type { JsonObject, JsonValue } from "./types.ts";

/**
 * A relative property path inside a node's props: the first segment is a
 * property name, later segments are object keys (strings) or array indexes
 * (numbers). Array indexes are positions in a known context and are
 * transformed like any other sequence position; they are never resolved by
 * searching for an equal value.
 */
export type PropPath = readonly (string | number)[];

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

export function samePath(a: PropPath, b: PropPath): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/** True when `prefix` is a (non-strict) prefix of `path`. */
export function isPathPrefix(prefix: PropPath, path: PropPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a value; `undefined` means absent (unset), which is distinct from JSON `null`. */
export function getAtPath(props: JsonObject, path: PropPath): JsonValue | undefined {
  let cursor: JsonValue | undefined = props;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = (cursor as readonly JsonValue[])[segment];
    } else {
      if (!isObject(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
      cursor = cursor[segment];
    }
  }
  return cursor;
}

/**
 * Return new props with the value at `path` replaced (`undefined` removes an
 * object key). Throws for a path whose container does not exist or whose
 * array index is out of range: callers treat that as a failed precondition.
 */
export function setAtPath(
  props: JsonObject,
  path: PropPath,
  value: JsonValue | undefined,
): JsonObject {
  const result = replaceIn(props, path, 0, value);
  if (!isObject(result)) throw new PathError("root props must stay an object");
  return result;
}

export class PathError extends Error {}

function replaceIn(
  container: JsonValue | undefined,
  path: PropPath,
  depth: number,
  value: JsonValue | undefined,
): JsonValue | undefined {
  if (depth === path.length) return value;
  const segment = path[depth];
  if (typeof segment === "number") {
    if (!Array.isArray(container)) throw new PathError("expected an array");
    const array = container as readonly JsonValue[];
    if (!Number.isSafeInteger(segment) || segment < 0 || segment >= array.length)
      throw new PathError("array index out of range");
    const next = replaceIn(array[segment], path, depth + 1, value);
    if (next === undefined) throw new PathError("array elements cannot be unset");
    return array.map((item, i) => (i === segment ? next : item));
  }
  if (segment === undefined || !isSafeKey(segment)) throw new PathError("unsafe key");
  if (!isObject(container)) throw new PathError("expected an object");
  const next = replaceIn(
    Object.hasOwn(container, segment) ? container[segment] : undefined,
    path,
    depth + 1,
    value,
  );
  const copy: Record<string, JsonValue> = { ...container };
  if (next === undefined) delete copy[segment];
  else copy[segment] = next;
  return copy;
}
