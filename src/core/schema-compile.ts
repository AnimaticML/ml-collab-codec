import type { JsonObject } from "./types.ts";
import { type Diagnostic, DiagnosticError, diag } from "./diagnostics.ts";
import type { AdditionalPolicy, PropertySchema } from "./schema.ts";
import { SCHEMA_LIMITS } from "./schema-definition.ts";
import { checkKeywords, isRecord } from "./schema-keywords.ts";
import { standardDiagnostics, withDefinitions } from "./schema-standard.ts";

type Raw = Readonly<Record<string, unknown>>;
type Mutable = Record<string, unknown>;

const PRIMITIVE_ITEMS = new Set(["string", "number", "integer", "boolean"]);
const REF_SIBLINGS = new Set(["$ref", "$comment", "title", "description", "deprecated"]);
const DEF_REF = /^#\/\$defs\/([^/~]+)$/;

/** Compiles JSON Schema property schemas into shared descriptors; collects every diagnostic. */
export class SchemaCompiler {
  readonly diagnostics: Diagnostic[] = [];
  private readonly placeholders = new Map<string, Mutable>();
  private readonly defaults: { raw: Raw; path: string }[] = [];
  /** Comma encodings, checked once every `$ref` target is compiled. */
  private readonly encodings: { raw: Raw; path: string; out: Mutable }[] = [];
  private nodes = 0;

  constructor(private readonly defs: Raw) {
    for (const name of Object.keys(defs)) this.placeholders.set(name, {});
  }

  compileDefinitions(): void {
    for (const [name, raw] of Object.entries(this.defs)) {
      if (this.isAliasCycle(name)) {
        this.diagnostics.push(
          diag("invalidSchema", `$defs.${name}`, "definition refers only to itself"),
        );
        continue;
      }
      const compiled = this.compile(raw, `$defs.${name}`, 0);
      Object.assign(this.placeholders.get(name) ?? {}, compiled);
    }
  }

  private isAliasCycle(start: string): boolean {
    const seen = new Set<string>();
    let cursor: unknown = this.defs[start];
    while (isRecord(cursor) && typeof cursor["$ref"] === "string") {
      const name = DEF_REF.exec(cursor["$ref"])?.[1];
      if (name === undefined || seen.has(name)) return name !== undefined;
      seen.add(name);
      if (name === start) return true;
      cursor = this.defs[name];
    }
    return false;
  }

  compile(raw: unknown, path: string, depth: number): PropertySchema {
    this.nodes += 1;
    if (depth > SCHEMA_LIMITS.maxDepth || this.nodes > SCHEMA_LIMITS.maxNodes) {
      this.diagnostics.push(
        diag("limitExceeded", path, "schema exceeds the supported size or depth"),
      );
      return {};
    }
    if (!isRecord(raw)) {
      this.diagnostics.push(diag("invalidSchema", path, "a schema must be an object"));
      return {};
    }
    this.diagnostics.push(...checkKeywords(raw, path));
    if ("$ref" in raw) return this.reference(raw, path);
    if ("default" in raw) this.defaults.push({ raw, path });
    const out: Mutable = {};
    if (typeof raw["type"] === "string") out["type"] = raw["type"];
    if (Array.isArray(raw["enum"])) out["enum"] = raw["enum"];
    if ("const" in raw) out["const"] = raw["const"];
    if ("default" in raw) out["default"] = raw["default"];
    this.annotations(raw, path, out);
    if (Array.isArray(raw["oneOf"]) || Array.isArray(raw["anyOf"]))
      this.variants(raw, path, depth, out);
    if ("items" in raw) out["items"] = this.compile(raw["items"], `${path}.items`, depth + 1);
    if (out["type"] === "object" || "properties" in raw || "additionalProperties" in raw)
      this.object(raw, path, depth, out);
    this.encoding(raw, path, out);
    return out;
  }

  private reference(raw: Raw, path: string): PropertySchema {
    const ref = raw["$ref"];
    const name = typeof ref === "string" ? DEF_REF.exec(ref)?.[1] : undefined;
    const target = name === undefined ? undefined : this.placeholders.get(name);
    if (target === undefined) {
      this.diagnostics.push(
        diag(
          "invalidSchema",
          `${path}.$ref`,
          "only existing local #/$defs/<name> references are supported",
        ),
      );
      return {};
    }
    for (const key of Object.keys(raw))
      if (!REF_SIBLINGS.has(key))
        this.diagnostics.push(
          diag("capabilityUnsupported", `${path}.${key}`, `"${key}" cannot be combined with $ref`),
        );
    return target;
  }

  private annotations(raw: Raw, path: string, out: Mutable): void {
    const numeric = raw["type"] === "number" || raw["type"] === "integer";
    if (raw["x-additive"] === true) {
      if (numeric) out["additive"] = true;
      else
        this.diagnostics.push(
          diag(
            "invalidSchema",
            `${path}.x-additive`,
            "x-additive requires a number or integer type",
          ),
        );
    }
    const reference = raw["x-reference"];
    if (reference === "definition" || reference === "reference") {
      if (raw["type"] === "string") out["reference"] = reference;
      else
        this.diagnostics.push(
          diag("invalidSchema", `${path}.x-reference`, "x-reference requires a string type"),
        );
    }
  }

  private variants(raw: Raw, path: string, depth: number, out: Mutable): void {
    for (const key of ["oneOf", "anyOf"]) {
      const branches = raw[key];
      if (!Array.isArray(branches)) continue;
      if (branches.length === 0)
        this.diagnostics.push(
          diag("invalidSchema", `${path}.${key}`, `${key} needs at least one schema`),
        );
      branches.forEach((branch, i) => this.compile(branch, `${path}.${key}[${i}]`, depth + 1));
    }
    out["variants"] = true;
  }

  private object(raw: Raw, path: string, depth: number, out: Mutable): void {
    const properties: Record<string, PropertySchema> = {};
    const declared = raw["properties"];
    if (declared !== undefined && !isRecord(declared))
      this.diagnostics.push(
        diag("invalidSchema", `${path}.properties`, "properties must be an object"),
      );
    for (const [name, schema] of Object.entries(isRecord(declared) ? declared : {}))
      properties[name] = this.compile(schema, `${path}.properties.${name}`, depth + 1);
    out["properties"] = properties;
    const required = Array.isArray(raw["required"]) ? (raw["required"] as string[]) : [];
    out["required"] = required;
    for (const name of required)
      if (isRecord(declared) && isRecord(declared[name]) && "default" in declared[name])
        this.diagnostics.push(
          diag(
            "invalidSchema",
            `${path}.properties.${name}.default`,
            "a required property cannot declare a default",
          ),
        );
    out["additional"] = this.additional(raw["additionalProperties"], path, depth);
  }

  private additional(value: unknown, path: string, depth: number): AdditionalPolicy {
    if (value === false) return { kind: "reject" };
    if (value === undefined || value === true) return { kind: "preserve" };
    return {
      kind: "schema",
      schema: this.compile(value, `${path}.additionalProperties`, depth + 1),
    };
  }

  private encoding(raw: Raw, path: string, out: Mutable): void {
    if (raw["x-encoding"] === "comma") this.encodings.push({ raw, path, out });
  }

  /** The comma shorthand needs an array whose (resolved) items are primitive. */
  checkEncodings(): void {
    for (const { raw, path, out } of this.encodings) {
      const itemType = (out["items"] as PropertySchema | undefined)?.type;
      if (raw["type"] === "array" && itemType !== undefined && PRIMITIVE_ITEMS.has(itemType))
        out["commaShorthand"] = true;
      else
        this.diagnostics.push(
          diag(
            "invalidSchema",
            `${path}.x-encoding`,
            "comma encoding requires an array of primitive items",
          ),
        );
    }
  }

  /** Defaults must satisfy their complete declared constraints. */
  checkDefaults(definitions: JsonObject): void {
    for (const { raw, path } of this.defaults) {
      const { default: value, ...schema } = raw;
      const issues = standardDiagnostics(
        withDefinitions(schema as JsonObject, definitions),
        value as JsonObject,
        `${path}.default`,
      );
      for (const issue of issues)
        this.diagnostics.push(
          diag("invalidSchema", issue.path, `default is invalid: ${issue.message}`),
        );
    }
  }

  finish(): void {
    if (this.diagnostics.length > 0) throw new DiagnosticError(this.diagnostics);
  }
}
