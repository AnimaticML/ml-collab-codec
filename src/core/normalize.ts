import type { JsonObject, JsonValue } from "./types.ts";
import type { PropertySchema, SchemaProfile } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { standardDiagnostics } from "./schema-standard.ts";
import { copyJson, enter, isUnsafeKey, newWalk, type Walk } from "./json-copy.ts";

/**
 * Effective-value normalization (SPEC 3), applied recursively to every
 * object member and array item. An omitted property, an explicit `null`, and
 * the declared default are one application state (the default is
 * materialized). `false`, `0`, and `""` are values, never absence. Unknown
 * keys are diagnosed or preserved according to `additionalProperties`; they
 * are never silently dropped. The result is always a fresh copy: callers may
 * keep mutating their input without affecting it.
 */
type Out = { value: JsonValue | undefined };

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeError(schema: PropertySchema, value: unknown): boolean {
  switch (schema.type) {
    case undefined:
      return false;
    case "string":
      return typeof value !== "string";
    case "number":
      return typeof value !== "number";
    case "integer":
      return typeof value !== "number" || !Number.isInteger(value);
    case "boolean":
      return typeof value !== "boolean";
    case "array":
      return !Array.isArray(value);
    case "object":
      return !isObject(value);
    default:
      return false;
  }
}

function normalizeObject(
  schema: PropertySchema,
  value: Readonly<Record<string, unknown>>,
  path: string,
  depth: number,
  walk: Walk,
): JsonObject {
  const out: Record<string, JsonValue> = {};
  const declared = schema.properties ?? {};
  for (const [name, property] of Object.entries(declared)) {
    const raw = Object.hasOwn(value, name) ? value[name] : undefined;
    const result = normalizeMember(
      name,
      property,
      raw,
      schema.required ?? [],
      `${path}.${name}`,
      depth,
      walk,
    );
    if (result.value !== undefined) out[name] = result.value;
  }
  for (const name of schema.required ?? [])
    if (!Object.hasOwn(declared, name) && (value[name] === undefined || value[name] === null))
      walk.diagnostics.push(diag("missingRequired", `${path}.${name}`, `"${name}" is required`));
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(declared, key)) continue;
    const at = `${path}.${key}`;
    if (isUnsafeKey(key))
      walk.diagnostics.push(diag("unsafeKey", at, `key "${key}" is not allowed`));
    else if (schema.additional?.kind === "reject")
      walk.diagnostics.push(diag("unknownProperty", at, `unknown property "${key}"`));
    else if (item !== undefined && item !== null) {
      const additional =
        schema.additional?.kind === "schema" ? schema.additional.schema : undefined;
      const copied =
        additional === undefined
          ? copyJson(item, at, depth + 1, walk)
          : normalizeValue(additional, item, at, depth + 1, walk);
      if (copied !== undefined) out[key] = copied;
    }
  }
  return out;
}

function normalizeMember(
  name: string,
  property: PropertySchema,
  raw: unknown,
  required: readonly string[],
  path: string,
  depth: number,
  walk: Walk,
): Out {
  if (raw === undefined || raw === null) {
    if (property.default !== undefined)
      return { value: copyJson(property.default, path, depth + 1, walk) };
    if (required.includes(name))
      walk.diagnostics.push(diag("missingRequired", path, `"${name}" is required`));
    return { value: undefined };
  }
  return { value: normalizeValue(property, raw, path, depth + 1, walk) };
}

/** Normalize one value against its descriptor (recursing into members and items). */
function normalizeValue(
  schema: PropertySchema,
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
): JsonValue | undefined {
  if (typeError(schema, value)) {
    walk.diagnostics.push(diag("invalidValue", path, `expected ${schema.type ?? "a valid value"}`));
    return undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    walk.diagnostics.push(diag("invalidValue", path, "numbers must be finite"));
    return undefined;
  }
  if (schema.variants === true || typeof value !== "object" || value === null)
    return copyJson(value, path, depth, walk);
  if (!enter(value, path, depth, walk)) return undefined;
  walk.ancestors.add(value);
  const items = schema.items;
  const result: JsonValue = Array.isArray(value)
    ? items === undefined
      ? (copyJson(value, path, depth, walk) ?? [])
      : value.map(
          (item, i) => normalizeValue(items, item, `${path}[${i}]`, depth + 1, walk) ?? null,
        )
    : schema.properties !== undefined || schema.additional !== undefined
      ? normalizeObject(schema, value as Readonly<Record<string, unknown>>, path, depth, walk)
      : (copyJson(value, path, depth, walk) ?? {});
  walk.ancestors.delete(value);
  return result;
}

interface NormalizeResult {
  readonly value: JsonObject;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Normalize a component's properties to their effective value, then check the
 * result against the component's standard JSON Schema.
 */
export function normalizeComponentProps(
  profile: SchemaProfile,
  tag: string,
  raw: unknown,
  path: string,
): NormalizeResult {
  const component = Object.hasOwn(profile.components, tag) ? profile.components[tag] : undefined;
  const walk: Walk = newWalk();
  if (component === undefined) {
    const copied = isObject(raw) ? copyJson(raw, path, 0, walk) : undefined;
    if (!isObject(raw))
      walk.diagnostics.push(diag("invalidValue", path, "props must be an object"));
    return { value: (copied ?? {}) as JsonObject, diagnostics: walk.diagnostics };
  }
  if (!isObject(raw))
    return { value: {}, diagnostics: [diag("invalidValue", path, "props must be an object")] };
  const value = normalizeObject(component.props, raw, path, 0, walk);
  const standard = profile.standardProps[tag];
  const assertions = standard === undefined ? [] : standardDiagnostics(standard, value, path);
  // A value dropped for a structural problem is already diagnosed at its path; the remaining
  // assertion failures elsewhere are reported too, so one error never hides another.
  const covered = (d: Diagnostic): boolean =>
    walk.diagnostics.some(
      (w) =>
        d.path === w.path || d.path.startsWith(`${w.path}.`) || d.path.startsWith(`${w.path}[`),
    );
  return { value, diagnostics: [...walk.diagnostics, ...assertions.filter((d) => !covered(d))] };
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return (
      a.length === b.length &&
      a.every((item: JsonValue, index) => deepEqual(item, b[index] as JsonValue))
    );
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
    return aKeys.every((key) =>
      deepEqual((a as JsonObject)[key] ?? null, (b as JsonObject)[key] ?? null),
    );
  }
  return false;
}
