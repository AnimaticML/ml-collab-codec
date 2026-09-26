import type { JsonValue } from "./types.ts";
import type { ContentMode } from "./schema.ts";

/**
 * A property schema in the supported JSON Schema 2020-12 subset (see
 * `docs/schema.md`). Standard keywords keep their standard meaning; library
 * annotations use `x-` keywords, which standard validators ignore:
 *
 * - `x-additive: true` — a number/integer field that accepts `delta` edits.
 * - `x-reference: "definition" | "reference"` — domain reference roles.
 * - `x-encoding: "comma"` — a primitive array may use `a,b,c` attribute shorthand.
 */
export interface JsonSchema {
  readonly $ref?: string;
  readonly $comment?: string;
  readonly title?: string;
  readonly description?: string;
  readonly default?: JsonValue;
  readonly examples?: readonly JsonValue[];
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly "x-additive"?: boolean;
  readonly "x-reference"?: "definition" | "reference";
  readonly "x-encoding"?: "comma";
}

export interface ComponentDefinition {
  /** `stable`: every instance carries a persistent `id`. `none`: anonymous. */
  readonly identity: "stable" | "none";
  readonly content: { readonly mode: ContentMode; readonly allowedTags?: readonly string[] };
  /** Object schema of the component's properties (`type: "object"`). */
  readonly props: JsonSchema;
  /** A string property whose value names the principal owning this visibility region. */
  readonly regionOwner?: string;
}

/**
 * A document schema manifest: JSON-serializable, versioned, and the single
 * source for parsing, validation, editing checks, and provider export.
 */
export interface DocumentSchemaDefinition {
  readonly $schema?: "https://json-schema.org/draft/2020-12/schema";
  readonly id: string;
  readonly version: string;
  readonly rootTag: string;
  /** Tags the schema does not declare: `reject` (default) or `preserve` opaquely. */
  readonly unknownComponents?: "reject" | "preserve";
  /** Shared definitions referenced as `{ "$ref": "#/$defs/name" }`. */
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly components: Readonly<Record<string, ComponentDefinition>>;
}

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Keywords accepted in property schemas; anything else is a capability diagnostic. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
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
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "oneOf",
  "anyOf",
  "x-additive",
  "x-reference",
  "x-encoding",
]);

/** Resource bounds on schemas themselves (a schema is data; these bound registration cost). */
export const SCHEMA_LIMITS = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxPatternLength: 256,
  maxDeclaredLength: 10_000_000,
} as const;
