import { canonicalJson } from "../core/change-codec.ts";
import { normalizeComponentProps } from "../core/normalize.ts";
import { defineDocumentSchema } from "../core/schema-document.ts";
import type { SchemaProfile } from "../core/schema.ts";
import { children } from "../core/table.ts";
import type { Table, TableNode } from "../core/table.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { isJsonArray, isJsonObject } from "../core/types.ts";
import { fail, record, segments, token } from "./native.ts";

interface Entry {
  contract: JsonObject;
  readonly fields: Map<string, Entry>;
  declared: boolean;
}

export interface CompositionField {
  readonly id: string;
  readonly scope: string;
  readonly path: string;
  readonly label: JsonValue | undefined;
  readonly required: boolean;
  /** Required members contributed by this field's contract, subject to its condition. */
  readonly requiredMembers?: readonly string[];
  readonly condition: { readonly path: string; readonly equals: JsonValue } | undefined;
  readonly target: string | undefined;
  readonly property: string | undefined;
}

export interface CompositionInterface {
  readonly fields: readonly CompositionField[];
  readonly required: ReadonlyMap<string, readonly string[]>;
  readonly scopes: ReadonlyMap<string, SchemaProfile>;
}

const entry = (): Entry => ({ contract: {}, fields: new Map(), declared: false });
const lowerBounds = new Set(["minimum", "minLength", "minItems", "minProperties"]);
const upperBounds = new Set(["maximum", "maxLength", "maxItems", "maxProperties"]);

function same(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function mergeFact(key: string, a: JsonValue, b: JsonValue, at: string): JsonValue {
  if (same(a, b)) return a;
  if (
    key === "type" &&
    ((a === "integer" && b === "number") || (a === "number" && b === "integer"))
  )
    return "integer";
  if (typeof a === "number" && typeof b === "number") {
    if (lowerBounds.has(key)) return Math.max(a, b);
    if (upperBounds.has(key)) return Math.min(a, b);
  }
  if (key === "enum" && isJsonArray(a) && isJsonArray(b)) {
    const shared = a.filter((item) => b.some((value) => same(item, value)));
    if (shared.length > 0)
      return shared.sort((x, y) =>
        canonicalJson(x) < canonicalJson(y) ? -1 : canonicalJson(x) > canonicalJson(y) ? 1 : 0,
      );
  }
  if (key === "required" && isJsonArray(a) && isJsonArray(b))
    return [...new Set([...a, ...b])].sort();
  return fail(at, `incompatible ${key} declarations`);
}

function combine(a: JsonObject, b: JsonObject, at: string): JsonObject {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const previous = out[key];
    out[key] = previous === undefined ? value : mergeFact(key, previous, value, at);
  }
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
  ] as const) {
    const lo = out[min];
    const hi = out[max];
    if (typeof lo === "number" && typeof hi === "number" && lo > hi)
      fail(at, `impossible ${min}/${max} range`);
  }
  return out;
}

function checkNumericContract(contract: JsonObject, at: string): JsonObject {
  if (contract["type"] === "number" || contract["type"] === "integer") {
    const minimum = contract["minimum"];
    const maximum = contract["maximum"];
    const exclusiveMinimum = contract["exclusiveMinimum"];
    const exclusiveMaximum = contract["exclusiveMaximum"];
    const lo = Math.max(
      typeof minimum === "number" ? minimum : -Infinity,
      typeof exclusiveMinimum === "number" ? exclusiveMinimum : -Infinity,
    );
    const hi = Math.min(
      typeof maximum === "number" ? maximum : Infinity,
      typeof exclusiveMaximum === "number" ? exclusiveMaximum : Infinity,
    );
    const excludesLow = lo === exclusiveMinimum;
    const excludesHigh = hi === exclusiveMaximum;
    const impossible =
      contract["type"] === "integer"
        ? Math.ceil(lo) + Number(excludesLow && Number.isInteger(lo)) >
          Math.floor(hi) - Number(excludesHigh && Number.isInteger(hi))
        : lo > hi || (lo === hi && (excludesLow || excludesHigh));
    if (impossible) fail(at, "numeric constraints have no valid value");
  }
  return contract;
}

function child(parent: Entry, key: string): Entry {
  let node = parent.fields.get(key);
  if (node === undefined) {
    node = entry();
    parent.fields.set(key, node);
  }
  return node;
}

function contribute(
  node: Entry,
  schema: JsonObject,
  at: string,
  path: string,
  requiredMembers: string[],
): void {
  const { properties, ...facts } = schema;
  node.declared = true;
  node.contract = combine(node.contract, facts, at);
  if (isJsonArray(facts["required"])) {
    for (const name of facts["required"]) {
      if (typeof name !== "string") fail(at, "required member must have a declaration");
      requiredMembers.push(`${path}.${name}`);
    }
  }
  if (properties === undefined) return;
  if (!isJsonObject(properties)) fail(at, "properties must be an object");
  for (const [key, value] of Object.entries(properties)) {
    if (segments(key).length !== 1 || !isJsonObject(value))
      fail(at, "invalid object property contract");
    contribute(child(node, key), value, at, `${path}.${key}`, requiredMembers);
  }
}

function compile(node: Entry, at: string): JsonObject {
  if (node.fields.size === 0 && node.contract["type"] !== "object") {
    if (!node.declared) fail(at, "path has no typed declaration");
    return checkNumericContract(node.contract, at);
  }
  if (node.contract["type"] !== undefined && node.contract["type"] !== "object")
    fail(at, "scalar/object collision");
  const properties: Record<string, JsonObject> = {};
  for (const name of [...node.fields.keys()].sort()) {
    const field = node.fields.get(name);
    if (field !== undefined) properties[name] = compile(field, `${at}.${name}`);
  }
  // Required inputs affect readiness, while the native document accepts partial objects.
  const { required: _required, ...contract } = node.contract;
  return checkNumericContract(
    { additionalProperties: false, ...contract, type: "object", properties },
    at,
  );
}

function requiredPaths(node: Entry, prefix: string[] = []): string[] {
  const explicit = node.contract["required"];
  const paths = isJsonArray(explicit)
    ? explicit.map((name) => {
        if (typeof name !== "string" || !node.fields.has(name))
          fail(prefix.join("."), "required member must have a declaration");
        return [...prefix, name].join(".");
      })
    : [];
  for (const [name, field] of node.fields) paths.push(...requiredPaths(field, [...prefix, name]));
  return paths;
}

function fieldOf(row: TableNode): CompositionField {
  const { scope, path, label, required, when, target, property } = row.props;
  const targetId = target === undefined ? undefined : token(target, row.id);
  const propertyName = property === undefined ? undefined : token(property, row.id);
  if ((targetId === undefined) !== (propertyName === undefined))
    fail(row.id, "a binding needs both a fragment node and property");
  const condition = when === undefined ? undefined : record(when);
  const pathTest = condition?.["path"];
  const equals = condition?.["equals"];
  if (condition !== undefined && (typeof pathTest !== "string" || equals === undefined))
    fail(row.id, "condition needs a path and equals value");
  if (typeof pathTest === "string") segments(pathTest);
  return {
    condition:
      typeof pathTest === "string" && equals !== undefined ? { path: pathTest, equals } : undefined,
    id: row.id,
    scope: token(scope, row.id),
    path: token(path, row.id),
    label,
    required: required === true,
    target: targetId,
    property: propertyName,
  };
}

export function inferComposition(table: Table, definition: string): CompositionInterface {
  if (table.get(definition)?.tag !== "compositionDefinition")
    fail(definition, "unknown definition");
  const roots = new Map<string, Entry>();
  const fields = children(table, definition).map((row) => {
    const field = fieldOf(row);
    let scope = roots.get(field.scope);
    if (scope === undefined) {
      scope = entry();
      roots.set(field.scope, scope);
    }
    let node = scope;
    for (const part of segments(field.path)) node = child(node, part);
    if (row.props["contract"] === undefined) return field;
    const requiredMembers: string[] = [];
    contribute(node, record(row.props["contract"]), row.id, field.path, requiredMembers);
    return requiredMembers.length === 0 ? field : { ...field, requiredMembers };
  });
  for (const field of fields) {
    if (field.condition === undefined) continue;
    let input = roots.get(field.scope);
    for (const part of segments(field.condition.path)) input = input?.fields.get(part);
    if (input === undefined) fail(field.id, "condition references an unknown path");
  }
  const scopes = new Map<string, SchemaProfile>();
  for (const [scope, root] of roots) {
    try {
      scopes.set(
        scope,
        defineDocumentSchema({
          id: "composition-values",
          version: "1",
          rootTag: "values",
          components: {
            values: {
              identity: "none",
              content: { mode: "none" },
              props: compile(root, `${definition}.${scope}`),
            },
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      fail(definition, error.message);
    }
  }
  return {
    fields,
    scopes,
    required: new Map([...roots].map(([name, root]) => [name, requiredPaths(root)])),
  };
}

export function normalizeValues(
  model: CompositionInterface,
  scope: string,
  values: JsonObject,
  at: string,
): JsonObject {
  const profile = model.scopes.get(scope);
  if (profile === undefined && model.scopes.size === 0 && Object.keys(values).length === 0)
    return {};
  if (profile === undefined) fail(at, `unknown scope "${scope}"`);
  const result = normalizeComponentProps(profile, "values", values, at);
  const first = result.diagnostics[0];
  if (first !== undefined) fail(first.path, first.message);
  return result.value;
}
