import type { JsonObject, JsonValue } from "./types.ts";
import { isJsonObject } from "./types.ts";
import type { ProviderProfile } from "./provider-profiles.ts";

/**
 * Translate the library's JSON Schema into one provider's supported subset.
 * Every assertion is either kept (and recorded as generation-enforced at its
 * path) or dropped (and recorded as local-only, still checked after decode).
 * Objects are always closed; unset optional values follow the provider's
 * convention (omitted, or a required null).
 */
export interface EmitContext {
  readonly profile: ProviderProfile;
  readonly definitions: JsonObject;
  readonly enforced: string[];
  readonly localOnly: string[];
  readonly incompatibilities: string[];
  /** Emitted `$defs`, keyed by emitted name. */
  readonly defs: Record<string, JsonObject>;
  /** Definitions currently being emitted (a reference back to one is recursion). */
  readonly inProgress: Set<string>;
}

const ANNOTATIONS = new Set(["title", "description"]);
const STRING_KEYS = ["minLength", "maxLength", "pattern", "format"];
const NUMBER_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const ARRAY_KEYS = ["minItems", "maxItems", "uniqueItems"];
const OBJECT_KEYS = ["minProperties", "maxProperties"];

export function newContext(profile: ProviderProfile, definitions: JsonObject): EmitContext {
  return {
    profile,
    definitions,
    enforced: [],
    localOnly: [],
    incompatibilities: [],
    defs: {},
    inProgress: new Set(),
  };
}

function keepAssertion(
  raw: JsonObject,
  key: string,
  path: string,
  out: Record<string, JsonValue>,
  ctx: EmitContext,
): void {
  const value = raw[key];
  if (value === undefined) return;
  const allowedMin =
    key !== "minItems" ||
    ctx.profile.minItemsValues === undefined ||
    (typeof value === "number" && ctx.profile.minItemsValues.includes(value));
  if (ctx.profile.enforced.has(key) && allowedMin) {
    out[key] = value;
    ctx.enforced.push(`${path}:${key}`);
  } else ctx.localOnly.push(`${path}:${key}`);
}

function emitEnum(
  raw: JsonObject,
  path: string,
  out: Record<string, JsonValue>,
  ctx: EmitContext,
): void {
  const members = raw["enum"] as readonly JsonValue[] | undefined;
  if (members !== undefined) {
    if (ctx.profile.scalarEnums && members.some((m) => typeof m === "object" && m !== null))
      ctx.localOnly.push(`${path}:enum`);
    else {
      out["enum"] = members;
      ctx.enforced.push(`${path}:enum`);
    }
  }
  if (!("const" in raw)) return;
  const value = raw["const"];
  if (ctx.profile.constKeyword) out["const"] = value;
  else if (typeof value !== "object" || value === null) out["enum"] = [value];
  else {
    ctx.localOnly.push(`${path}:const`);
    return;
  }
  ctx.enforced.push(`${path}:const`);
}

function emitReference(ref: string, path: string, ctx: EmitContext): JsonObject {
  const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1] ?? "";
  const emitted = `def_${name}`;
  if (ctx.inProgress.has(emitted) && !ctx.profile.recursion)
    ctx.incompatibilities.push(
      `${path}: recursive definition "${name}" is not supported by ${ctx.profile.id}`,
    );
  if (!Object.hasOwn(ctx.defs, emitted)) {
    ctx.defs[emitted] = {};
    ctx.inProgress.add(emitted);
    const source = ctx.definitions[name];
    ctx.defs[emitted] = emitSchema(isJsonObject(source) ? source : {}, `$defs.${name}`, ctx);
    ctx.inProgress.delete(emitted);
  }
  return { $ref: `#/$defs/${emitted}` };
}

function emitObject(
  raw: JsonObject,
  path: string,
  out: Record<string, JsonValue>,
  ctx: EmitContext,
): void {
  const properties = isJsonObject(raw["properties"]) ? raw["properties"] : {};
  const required = new Set(Array.isArray(raw["required"]) ? (raw["required"] as string[]) : []);
  const emitted: Record<string, JsonValue> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const child = emitSchema(isJsonObject(schema) ? schema : {}, `${path}.${name}`, ctx);
    emitted[name] =
      required.has(name) || ctx.profile.optionalProperties === "allowed" ? child : nullable(child);
  }
  out["type"] = "object";
  out["properties"] = emitted;
  out["required"] =
    ctx.profile.optionalProperties === "nullable"
      ? Object.keys(emitted)
      : [...required].filter((n) => Object.hasOwn(emitted, n));
  out["additionalProperties"] = false;
  ctx.enforced.push(`${path}:required`, `${path}:additionalProperties`);
  for (const key of OBJECT_KEYS) if (key in raw) ctx.localOnly.push(`${path}:${key}`);
}

/** Allow null in addition to the schema (the "unset" encoding of nullable providers). */
function nullable(schema: JsonObject): JsonObject {
  const type = schema["type"];
  if (typeof type === "string" && !("enum" in schema)) return { ...schema, type: [type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

export function emitSchema(raw: JsonObject, path: string, ctx: EmitContext): JsonObject {
  if (typeof raw["$ref"] === "string") return emitReference(raw["$ref"], path, ctx);
  const out: Record<string, JsonValue> = {};
  for (const key of ANNOTATIONS) if (typeof raw[key] === "string") out[key] = raw[key];
  const variants = (raw["oneOf"] ?? raw["anyOf"]) as readonly JsonValue[] | undefined;
  if (variants !== undefined) {
    out["anyOf"] = variants.map((branch, i) =>
      emitSchema(isJsonObject(branch) ? branch : {}, `${path}.anyOf[${i}]`, ctx),
    );
    ctx.enforced.push(`${path}:anyOf`);
    if ("oneOf" in raw) ctx.localOnly.push(`${path}:oneOf exclusivity`);
  }
  if (typeof raw["type"] === "string") {
    out["type"] = raw["type"];
    ctx.enforced.push(`${path}:type`);
  }
  emitEnum(raw, path, out, ctx);
  for (const key of [...STRING_KEYS, ...NUMBER_KEYS, ...ARRAY_KEYS])
    keepAssertion(raw, key, path, out, ctx);
  if (isJsonObject(raw["items"])) out["items"] = emitSchema(raw["items"], `${path}[]`, ctx);
  if (raw["type"] === "object" || "properties" in raw) emitObject(raw, path, out, ctx);
  return out;
}

export interface Measured {
  readonly depth: number;
  readonly properties: number;
  readonly variants: number;
}

/**
 * Count what is actually emitted: the deepest chain of nested objects/arrays
 * (following each reference at most once per path, so recursion counts one
 * cycle), declared properties, and union branches, each definition once.
 */
export function measureSchema(root: JsonObject): Measured {
  const defs = isJsonObject(root["$defs"]) ? root["$defs"] : {};
  let properties = 0;
  let variants = 0;
  const count = (schema: JsonValue | undefined): void => {
    if (!isJsonObject(schema)) return;
    const branches = Array.isArray(schema["anyOf"])
      ? (schema["anyOf"] as readonly JsonValue[])
      : [];
    variants += branches.length;
    const members = isJsonObject(schema["properties"]) ? Object.values(schema["properties"]) : [];
    properties += members.length;
    [schema["items"], ...members, ...branches].forEach(count);
  };
  count({ ...root, $defs: {} });
  Object.values(defs).forEach(count);
  // Memoized per definition; a reference back to a definition on the current path adds nothing.
  const memo = new Map<string, number>();
  const onPath = new Set<string>();
  const depthOf = (schema: JsonValue | undefined): number => {
    if (!isJsonObject(schema)) return 0;
    if (typeof schema["$ref"] === "string") {
      const ref = schema["$ref"].replace("#/$defs/", "");
      if (onPath.has(ref)) return 0;
      const known = memo.get(ref);
      if (known !== undefined) return known;
      onPath.add(ref);
      const value = depthOf(defs[ref]);
      onPath.delete(ref);
      memo.set(ref, value);
      return value;
    }
    const members = isJsonObject(schema["properties"]) ? Object.values(schema["properties"]) : [];
    const branches = Array.isArray(schema["anyOf"])
      ? (schema["anyOf"] as readonly JsonValue[])
      : [];
    const nested = Math.max(
      0,
      depthOf(schema["items"]),
      ...members.map(depthOf),
      ...branches.map(depthOf),
    );
    // Nullable types are emitted as type arrays, e.g. ["object", "null"].
    const types = Array.isArray(schema["type"]) ? schema["type"] : [schema["type"]];
    return nested + (types.includes("object") || types.includes("array") ? 1 : 0);
  };
  return { depth: depthOf(root), properties, variants };
}
