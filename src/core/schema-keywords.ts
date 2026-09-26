import type { JsonValue } from "./types.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { SCHEMA_LIMITS, SUPPORTED_KEYWORDS } from "./schema-definition.ts";

type Raw = Readonly<Record<string, unknown>>;

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const NUMERIC_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
const COUNT_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
];
const BOOLEAN_KEYWORDS = ["deprecated", "readOnly", "writeOnly", "uniqueItems", "x-additive"];
const TEXT_KEYWORDS = ["$comment", "title", "description"];

export function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON value built only from plain JSON data (no functions, cycles, or non-finite numbers). */
export function isJsonData(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): value is JsonValue {
  if (depth > SCHEMA_LIMITS.maxDepth * 4) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isJsonData(item, depth + 1, seen))
    : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
      ? Object.values(value).every((item) => isJsonData(item, depth + 1, seen))
      : false;
  seen.delete(value);
  return ok;
}

function checkScalars(schema: Raw, path: string, out: Diagnostic[]): void {
  for (const key of NUMERIC_KEYWORDS)
    if (key in schema && (typeof schema[key] !== "number" || !Number.isFinite(schema[key])))
      out.push(diag("invalidSchema", `${path}.${key}`, `${key} must be a finite number`));
  if ("multipleOf" in schema) {
    const m = schema["multipleOf"];
    if (typeof m !== "number" || !Number.isFinite(m) || m <= 0)
      out.push(diag("invalidSchema", `${path}.multipleOf`, "multipleOf must be a positive number"));
  }
  for (const key of COUNT_KEYWORDS) {
    if (!(key in schema)) continue;
    const n = schema[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      out.push(diag("invalidSchema", `${path}.${key}`, `${key} must be a non-negative integer`));
    else if (n > SCHEMA_LIMITS.maxDeclaredLength)
      out.push(
        diag("capabilityUnsupported", `${path}.${key}`, `${key} exceeds the supported limit`),
      );
  }
  for (const key of BOOLEAN_KEYWORDS)
    if (key in schema && typeof schema[key] !== "boolean")
      out.push(diag("invalidSchema", `${path}.${key}`, `${key} must be a boolean`));
  for (const key of TEXT_KEYWORDS)
    if (key in schema && typeof schema[key] !== "string")
      out.push(diag("invalidSchema", `${path}.${key}`, `${key} must be a string`));
}

function checkPattern(schema: Raw, path: string, out: Diagnostic[]): void {
  if (!("pattern" in schema)) return;
  const pattern = schema["pattern"];
  if (typeof pattern !== "string") {
    out.push(diag("invalidSchema", `${path}.pattern`, "pattern must be a string"));
    return;
  }
  if (pattern.length > SCHEMA_LIMITS.maxPatternLength) {
    out.push(
      diag("capabilityUnsupported", `${path}.pattern`, "pattern exceeds the supported length"),
    );
    return;
  }
  try {
    new RegExp(pattern, "u");
  } catch {
    out.push(diag("invalidSchema", `${path}.pattern`, "pattern is not a valid regular expression"));
  }
}

function checkTyping(schema: Raw, path: string, out: Diagnostic[]): void {
  if ("type" in schema) {
    const type = schema["type"];
    if (type === "null" || (Array.isArray(type) && type.includes("null")))
      out.push(
        diag(
          "capabilityUnsupported",
          `${path}.type`,
          "null is the unset value; omit the property instead",
        ),
      );
    else if (typeof type !== "string" || !TYPES.has(type))
      out.push(
        diag("capabilityUnsupported", `${path}.type`, "type must be one supported type name"),
      );
  }
  if (
    "enum" in schema &&
    (!Array.isArray(schema["enum"]) || schema["enum"].length === 0 || !isJsonData(schema["enum"]))
  )
    out.push(
      diag("invalidSchema", `${path}.enum`, "enum must be a non-empty array of JSON values"),
    );
  for (const key of ["const", "default"])
    if (key in schema && !isJsonData(schema[key]))
      out.push(diag("invalidSchema", `${path}.${key}`, `${key} must be JSON data`));
  if (
    "examples" in schema &&
    (!Array.isArray(schema["examples"]) || !isJsonData(schema["examples"]))
  )
    out.push(diag("invalidSchema", `${path}.examples`, "examples must be an array of JSON values"));
  if ("required" in schema) {
    const required = schema["required"];
    if (!Array.isArray(required) || !required.every((name) => typeof name === "string"))
      out.push(diag("invalidSchema", `${path}.required`, "required must be an array of names"));
  }
  const reference = schema["x-reference"];
  if (reference !== undefined && reference !== "definition" && reference !== "reference")
    out.push(
      diag(
        "invalidSchema",
        `${path}.x-reference`,
        'x-reference must be "definition" or "reference"',
      ),
    );
  if ("x-encoding" in schema && schema["x-encoding"] !== "comma")
    out.push(diag("invalidSchema", `${path}.x-encoding`, 'x-encoding must be "comma"'));
}

/** Check one schema node's own keywords (children are visited by the compiler). */
export function checkKeywords(schema: Raw, path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const key of Object.keys(schema))
    if (!SUPPORTED_KEYWORDS.has(key))
      out.push(
        diag("capabilityUnsupported", `${path}.${key}`, `keyword "${key}" is not supported`),
      );
  checkScalars(schema, path, out);
  checkPattern(schema, path, out);
  checkTyping(schema, path, out);
  return out;
}
