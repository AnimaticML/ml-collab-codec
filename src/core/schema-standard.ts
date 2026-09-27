import { Validator } from "@cfworker/json-schema";
import type { JsonObject, JsonValue } from "./types.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { JSON_SCHEMA_DIALECT } from "./schema-definition.ts";

/**
 * Standard JSON Schema 2020-12 assertions through an established, portable
 * validator (`@cfworker/json-schema`: interpretive, no code generation, so it
 * runs in workers and restricted runtimes). The library does not implement
 * its own generic validator; it only maps results to diagnostics.
 */
const ASSERTIONS = new Set([
  "type",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "required",
  "minProperties",
  "maxProperties",
  "oneOf",
  "anyOf",
]);

/** Build a standalone schema document for one subschema with the shared `$defs`. */
export function withDefinitions(schema: JsonObject, definitions: JsonObject): JsonObject {
  return { $schema: JSON_SCHEMA_DIALECT, $defs: definitions, ...schema };
}

const cache = new WeakMap<JsonObject, Validator>();

function validatorFor(schema: JsonObject): Validator {
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;
  const created = new Validator(schema, "2020-12", false);
  cache.set(schema, created);
  return created;
}

/** `#/a/0/b` → `.a[0].b` appended to the caller's diagnostic path. */
function pointerToPath(base: string, pointer: string): string {
  const segments = pointer.replace(/^#\/?/, "");
  if (segments.length === 0) return base;
  return segments
    .split("/")
    .map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce(
      (path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : `${path}.${segment}`),
      base,
    );
}

/**
 * Validate an effective value; returns leaf assertion failures with precise
 * paths. Errors inside individual `oneOf`/`anyOf` branches are summarized by
 * the variant failure itself rather than listing every branch's mismatch.
 */
export function standardDiagnostics(
  schema: JsonObject,
  value: JsonValue,
  path: string,
): Diagnostic[] {
  const result = validatorFor(schema).validate(value);
  if (result.valid) return [];
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const error of result.errors) {
    if (!ASSERTIONS.has(error.keyword)) continue;
    if (/\/(oneOf|anyOf)\/\d+\//.test(error.keywordLocation)) continue;
    const parent = pointerToPath(path, error.instanceLocation);
    // A missing required member is reported at the member's own path.
    const member = error.keyword === "required" ? /"([^"]+)"/.exec(error.error)?.[1] : undefined;
    const at = member === undefined ? parent : `${parent}.${member}`;
    const key = `${at}|${error.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const code = error.keyword === "required" ? "missingRequired" : "invalidValue";
    diagnostics.push(diag(code, at, error.error));
  }
  if (diagnostics.length === 0)
    diagnostics.push(diag("invalidValue", path, "value does not match its schema"));
  return diagnostics;
}
