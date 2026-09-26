import type { JsonObject, JsonValue } from "./types.ts";
import type { Change, Origin, SubtreeRecord } from "./change.ts";
import { isReplicaId } from "./identity.ts";
import { isSafeKey } from "./json-path.ts";
import type { PropPath } from "./json-path.ts";

/** Deterministic JSON with sorted object keys: the canonical bytes of a record or envelope. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const MAX_DEPTH = 64;

type Raw = Record<string, unknown>;

function object(value: unknown, path: string): Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DecodeError(path, "expected an object");
  return value as Raw;
}

function str(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DecodeError(`${path}.${key}`, "expected a non-empty string");
  return value;
}

function text(raw: Raw, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DecodeError(`${path}.${key}`, "expected non-empty text");
  if (/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")))
    throw new DecodeError(`${path}.${key}`, "text contains an unpaired surrogate");
  return value;
}

export function nonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new DecodeError(path, "expected a non-negative safe integer");
  return value;
}

export function jsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) throw new DecodeError(path, "value nesting exceeds the limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DecodeError(path, "numbers must be finite");
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, i) => jsonValue(item, `${path}[${i}]`, depth + 1));
  const raw = object(value, path);
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!isSafeKey(key)) throw new DecodeError(path, `unsafe key ${key}`);
    out[key] = jsonValue(item, `${path}.${key}`, depth + 1);
  }
  return out;
}

function propPath(value: unknown, path: string): PropPath {
  if (!Array.isArray(value) || value.length === 0)
    throw new DecodeError(path, "expected a non-empty path");
  return value.map((segment, i) => {
    if (typeof segment === "number") return nonNegativeInt(segment, `${path}[${i}]`);
    if (typeof segment !== "string" || !isSafeKey(segment) || (i === 0 && segment.length === 0))
      throw new DecodeError(`${path}[${i}]`, "invalid path segment");
    if (i === 0 && typeof value[0] !== "string")
      throw new DecodeError(path, "a path starts with a property name");
    return segment;
  });
}

function decodeOrigin(value: unknown, path: string): Origin {
  const raw = object(value, path);
  const replica = str(raw, "replica", path);
  if (!isReplicaId(replica)) throw new DecodeError(`${path}.replica`, "invalid replica id");
  const seq = nonNegativeInt(raw["seq"], `${path}.seq`);
  if (seq === 0) throw new DecodeError(`${path}.seq`, "origin sequences start at 1");
  return { replica, seq, ordinal: nonNegativeInt(raw["ordinal"], `${path}.ordinal`) };
}

function subtree(value: unknown, path: string, depth = 0): SubtreeRecord {
  if (depth > MAX_DEPTH) throw new DecodeError(path, "subtree nesting exceeds the limit");
  const raw = object(value, path);
  const children = raw["children"];
  if (!Array.isArray(children)) throw new DecodeError(`${path}.children`, "expected an array");
  const persisted = raw["persisted"];
  if (typeof persisted !== "boolean")
    throw new DecodeError(`${path}.persisted`, "expected a boolean");
  return {
    id: str(raw, "id", path),
    tag: str(raw, "tag", path),
    props: jsonValue(object(raw["props"], `${path}.props`), `${path}.props`) as JsonObject,
    persisted,
    children: children.map((child, i) => subtree(child, `${path}.children[${i}]`, depth + 1)),
  };
}

function values(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new DecodeError(path, "expected a non-empty array");
  return value.map((item, i) => jsonValue(item, `${path}[${i}]`));
}

interface Fields {
  readonly raw: Raw;
  readonly path: string;
  readonly origin: Origin;
  str(key: string): string;
  int(key: string): number;
  prop(): PropPath;
}

function decodeValueChange(kind: "set" | "delta", f: Fields): Change {
  const { raw, path } = f;
  if (kind === "set") {
    const before =
      raw["before"] === undefined ? {} : { before: jsonValue(raw["before"], `${path}.before`) };
    const after =
      raw["after"] === undefined ? {} : { after: jsonValue(raw["after"], `${path}.after`) };
    return { kind, node: f.str("node"), path: f.prop(), ...before, ...after, origin: f.origin };
  }
  const by = raw["by"];
  if (typeof by !== "number" || !Number.isSafeInteger(by) || by === 0)
    throw new DecodeError(`${path}.by`, "delta must be a non-zero safe integer");
  return { kind, node: f.str("node"), path: f.prop(), by, origin: f.origin };
}

function decodeSequenceChange(kind: string, f: Fields): Change | undefined {
  const { raw, path, origin } = f;
  switch (kind) {
    case "arrayInsert":
    case "arrayDelete":
      return {
        kind,
        node: f.str("node"),
        path: f.prop(),
        index: f.int("index"),
        values: values(raw["values"], `${path}.values`),
        origin,
      };
    case "arrayMove":
      return {
        kind,
        node: f.str("node"),
        path: f.prop(),
        from: f.int("from"),
        gap: f.int("gap"),
        origin,
      };
    case "textInsert":
    case "textDelete":
      return {
        kind,
        node: f.str("node"),
        offset: f.int("offset"),
        text: text(raw, "text", path),
        origin,
      };
    default:
      return undefined;
  }
}

function decodeStructuralChange(kind: string, f: Fields): Change | undefined {
  const { raw, path, origin } = f;
  switch (kind) {
    case "nodeInsert":
    case "nodeDelete":
      return {
        kind,
        parent: f.str("parent"),
        index: f.int("index"),
        subtree: subtree(raw["subtree"], `${path}.subtree`),
        origin,
      };
    case "nodeMove":
      return {
        kind,
        node: f.str("node"),
        fromParent: f.str("fromParent"),
        fromIndex: f.int("fromIndex"),
        toParent: f.str("toParent"),
        gap: f.int("gap"),
        origin,
      };
    case "setTag":
      return { kind, node: f.str("node"), before: f.str("before"), after: f.str("after"), origin };
    case "split":
    case "merge":
      return {
        kind,
        node: f.str("node"),
        other: f.str("other"),
        offset: f.int("offset"),
        parent: f.str("parent"),
        index: f.int("index"),
        origin,
      };
    default:
      return undefined;
  }
}

function decodeOne(value: unknown, path: string): Change {
  const raw = object(value, path);
  const fields: Fields = {
    raw,
    path,
    origin: decodeOrigin(raw["origin"], `${path}.origin`),
    str: (key) => str(raw, key, path),
    int: (key) => nonNegativeInt(raw[key], `${path}.${key}`),
    prop: () => propPath(raw["path"], `${path}.path`),
  };
  const kind = raw["kind"];
  if (kind === "set" || kind === "delta") return decodeValueChange(kind, fields);
  const decoded =
    typeof kind === "string"
      ? (decodeSequenceChange(kind, fields) ?? decodeStructuralChange(kind, fields))
      : undefined;
  if (decoded === undefined)
    throw new DecodeError(`${path}.kind`, `unsupported primitive ${String(kind)}`);
  // Unknown fields (e.g. a client-supplied `minItems`) are refused, never silently dropped.
  const extra = Object.keys(raw).find((key) => !(key in decoded));
  if (extra !== undefined) throw new DecodeError(`${path}.${extra}`, "unknown field");
  return decoded;
}

/** Strictly decode serialized primitives (`sdl.ops/2`); incomplete or unknown records are errors, never guessed. */
export function decodeChanges(value: unknown, path = "changes", limit = 10_000): Change[] {
  if (!Array.isArray(value)) throw new DecodeError(path, "expected an array of primitives");
  if (value.length > limit) throw new DecodeError(path, `more than ${limit} primitives`);
  return value.map((item, i) => decodeOne(item, `${path}[${i}]`));
}
