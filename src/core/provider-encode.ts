import type { ComponentNode, DocumentModel, JsonObject, JsonValue } from "./types.ts";
import { isJsonObject } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import type { ProviderExport } from "./provider-export.ts";

/**
 * Encode library data in the exact wire shape an export requests (the
 * inverse of `decodeProviderOutput`): for examples, few-shot prompts, and
 * round-trip tests. Unset optional values become `null` where the provider
 * requires every key, and are omitted otherwise.
 */
function resolve(schema: JsonValue | undefined, defs: JsonObject): JsonObject {
  let cursor = isJsonObject(schema) ? schema : {};
  for (let hops = 0; typeof cursor["$ref"] === "string" && hops < 64; hops += 1) {
    const target = defs[cursor["$ref"].replace("#/$defs/", "")];
    cursor = isJsonObject(target) ? target : {};
  }
  return cursor;
}

function allowsNull(schema: JsonObject): boolean {
  const type = schema["type"];
  if (Array.isArray(type) && type.includes("null")) return true;
  const branches = schema["anyOf"];
  return (
    Array.isArray(branches) &&
    branches.some((b: JsonValue) => isJsonObject(b) && b["type"] === "null")
  );
}

/** Fill a value for its emitted schema: nested objects get their required-null keys. */
function fill(value: JsonValue, schema: JsonObject, defs: JsonObject): JsonValue {
  const branches = Array.isArray(schema["anyOf"]) ? (schema["anyOf"] as readonly JsonValue[]) : [];
  const branch = branches.map((b) => resolve(b, defs)).find((b) => b["type"] !== "null");
  const target = branch ?? schema;
  if (Array.isArray(value))
    return value.map((item: JsonValue) => fill(item, resolve(target["items"], defs), defs));
  if (!isJsonObject(value)) return value;
  const properties = isJsonObject(target["properties"]) ? target["properties"] : {};
  const out: Record<string, JsonValue> = {};
  const required = Array.isArray(target["required"])
    ? (target["required"] as readonly string[])
    : [];
  for (const [key, member] of Object.entries(properties)) {
    const schemaOf = resolve(member, defs);
    const present = value[key];
    if (present !== undefined) out[key] = fill(present, schemaOf, defs);
    else if (required.includes(key) && allowsNull(isJsonObject(member) ? member : {}))
      out[key] = null;
  }
  return out;
}

function nativeNode(node: ComponentNode, profile: SchemaProfile, defs: JsonObject): JsonObject {
  const def = resolve({ $ref: `#/$defs/node_${node.tag}` }, defs);
  const properties = isJsonObject(def["properties"]) ? def["properties"] : {};
  const out: Record<string, JsonValue> = { tag: node.tag };
  if ("id" in properties && node.id !== undefined) out["id"] = node.id;
  out["props"] = fill(node.props, resolve(properties["props"], defs), defs);
  if ("content" in properties)
    out["content"] = (node.content ?? []).map((item) =>
      typeof item === "string" ? item : nativeNode(item, profile, defs),
    );
  return out;
}

function rowFor(
  node: ComponentNode,
  ref: string,
  parent: string | null,
  rowSchemas: readonly JsonObject[],
  defs: JsonObject,
): JsonObject {
  const schema =
    rowSchemas.find((row) => {
      const tag = isJsonObject(row["properties"]) ? row["properties"]["tag"] : undefined;
      return isJsonObject(tag) && Array.isArray(tag["enum"]) && tag["enum"][0] === node.tag;
    }) ?? {};
  const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};
  const row: Record<string, JsonValue> = { ref };
  if (parent !== null) row["parent"] = parent;
  row["tag"] = node.tag;
  if ("id" in properties && node.id !== undefined) row["id"] = node.id;
  row["props"] = fill(node.props, resolve(properties["props"], defs), defs);
  return row;
}

function rows(model: DocumentModel, exported: ProviderExport, defs: JsonObject): JsonObject {
  const top = exported.requestSchema["properties"] as JsonObject;
  const items = resolve((top["rows"] as JsonObject)["items"], defs);
  const variants = (
    Array.isArray(items["anyOf"]) ? (items["anyOf"] as readonly JsonValue[]) : [items]
  ).map((v) => resolve(v, defs));
  const out: JsonValue[] = [];
  let next = 0;
  const visit = (node: ComponentNode, ref: string): void => {
    for (const item of node.content ?? []) {
      const child = `r${(next += 1)}`;
      if (typeof item === "string") out.push({ ref: child, parent: ref, text: item });
      else {
        out.push(rowFor(item, child, ref, variants, defs));
        visit(item, child);
      }
    }
  };
  visit(model.root, "r0");
  return { root: rowFor(model.root, "r0", null, [resolve(top["root"], defs)], defs), rows: out };
}

export function encodeProviderOutput(
  exported: ProviderExport,
  data: DocumentModel | JsonObject,
  profile: SchemaProfile,
): JsonObject {
  const defs = isJsonObject(exported.requestSchema["$defs"]) ? exported.requestSchema["$defs"] : {};
  if (exported.scope === "componentProperties")
    return fill(data as JsonObject, exported.requestSchema, defs) as JsonObject;
  const model = data as DocumentModel;
  return exported.route === "nativeTree"
    ? { root: nativeNode(model.root, profile, defs) }
    : rows(model, exported, defs);
}
