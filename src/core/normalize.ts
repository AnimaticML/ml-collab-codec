import type { JsonObject, JsonValue } from "./types.ts";
import type { ComponentSchema, PropertySchema } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";

/**
 * Effective-value normalization (SPEC section 3). Omission, an explicit
 * `null`, and an explicit value equal to the declared default are the same
 * application state; the internal canonical representation of "unset" is
 * simply omitting the key. `false`, `0`, and `""` are real values and are
 * never treated as absence (no JavaScript truthiness).
 */
interface NormalizeResult {
  readonly value: JsonObject;
  readonly diagnostics: readonly Diagnostic[];
}

function typeMatches(type: PropertySchema["type"], value: JsonValue): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function normalizeScalarOrContainer(
  schema: PropertySchema,
  value: JsonValue,
  path: string,
): { value: JsonValue; diagnostics: Diagnostic[] } {
  if (!typeMatches(schema.type, value)) {
    return { value, diagnostics: [diag("invalidValue", path, `expected ${schema.type}`)] };
  }
  if (schema.type === "object" && schema.properties && !Array.isArray(value)) {
    const nested = normalizeProperties(schema.properties, value as JsonObject, path);
    return { value: nested.value, diagnostics: [...nested.diagnostics] };
  }
  return { value, diagnostics: [] };
}

function normalizeOne(
  name: string,
  schema: PropertySchema,
  raw: JsonValue | undefined,
  path: string,
): { value: JsonValue | undefined; diagnostics: Diagnostic[] } {
  const fieldPath = `${path}.${name}`;
  if (raw === undefined || raw === null) {
    if (schema.default !== undefined) return { value: schema.default, diagnostics: [] };
    if (schema.required) {
      return {
        value: undefined,
        diagnostics: [diag("missingRequired", fieldPath, `"${name}" is required`)],
      };
    }
    return { value: undefined, diagnostics: [] };
  }
  const normalized = normalizeScalarOrContainer(schema, raw, fieldPath);
  if (normalized.diagnostics.length > 0) return normalized;
  if (schema.default !== undefined && deepEqual(normalized.value, schema.default)) {
    return { value: schema.default, diagnostics: [] };
  }
  return normalized;
}

export function normalizeProperties(
  properties: Readonly<Record<string, PropertySchema>>,
  raw: JsonObject,
  path: string,
): NormalizeResult {
  const value: Record<string, JsonValue> = {};
  const diagnostics: Diagnostic[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    const result = normalizeOne(name, schema, raw[name], path);
    diagnostics.push(...result.diagnostics);
    if (result.value !== undefined) value[name] = result.value;
  }
  return { value, diagnostics };
}

export function normalizeComponentProps(
  component: ComponentSchema,
  raw: JsonObject,
  path: string,
): NormalizeResult {
  const known = normalizeProperties(component.properties, raw, path);
  const diagnostics = [...known.diagnostics];
  const value: Record<string, JsonValue> = { ...known.value };
  for (const key of Object.keys(raw)) {
    if (key in component.properties) continue;
    if (component.allowOpaqueProperties) {
      value[key] = raw[key] as JsonValue;
    } else {
      diagnostics.push(
        diag(
          "unknownProperty",
          `${path}.${key}`,
          `unknown property "${key}" on <${component.tag}>`,
        ),
      );
    }
  }
  return { value, diagnostics };
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return (
      a.length === b.length && a.every((item, index) => deepEqual(item, b[index] as JsonValue))
    );
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((key) => deepEqual(a[key] ?? null, b[key] ?? null));
  }
  return false;
}
