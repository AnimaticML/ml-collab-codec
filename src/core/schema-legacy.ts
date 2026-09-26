import type { JsonValue } from "./types.ts";
import type { ContentMode, SchemaProfile } from "./schema.ts";
import type {
  ComponentDefinition,
  DocumentSchemaDefinition,
  JsonSchema,
} from "./schema-definition.ts";
import { defineDocumentSchema } from "./schema-document.ts";
import { DiagnosticError, diag } from "./diagnostics.ts";

/** The pre-remediation compact property descriptor, kept only as an import format. */
export interface LegacyPropertySchema {
  readonly type: "string" | "number" | "boolean" | "array" | "object";
  readonly default?: JsonValue;
  readonly required?: boolean;
  readonly items?: LegacyPropertySchema;
  readonly minItems?: number;
  readonly properties?: Readonly<Record<string, LegacyPropertySchema>>;
  readonly additive?: boolean;
  readonly referenceRole?: "definition" | "reference";
  readonly commaShorthand?: boolean;
}

export interface LegacyComponentSchema {
  readonly tag: string;
  readonly identity: "stable" | "none";
  readonly properties: Readonly<Record<string, LegacyPropertySchema>>;
  readonly content: { readonly mode: ContentMode; readonly allowedTags?: readonly string[] };
  readonly allowOpaqueProperties?: boolean;
  readonly regionOwnerProp?: string;
}

export interface LegacySchemaProfile {
  readonly id: string;
  readonly version: string;
  readonly rootTag: string;
  readonly components: Readonly<Record<string, LegacyComponentSchema>>;
  readonly unknownPolicy: "error" | "opaque";
}

function migrateObject(
  properties: Readonly<Record<string, LegacyPropertySchema>>,
  additionalProperties: boolean,
): JsonSchema {
  const out: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, property] of Object.entries(properties)) {
    out[name] = migrateProperty(property);
    if (property.required === true) required.push(name);
  }
  return {
    type: "object",
    properties: out,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

function migrateProperty(property: LegacyPropertySchema): JsonSchema {
  if (property.type === "object")
    return {
      ...migrateObject(property.properties ?? {}, false),
      ...(property.default === undefined ? {} : { default: property.default }),
    };
  return {
    type: property.type,
    ...(property.default === undefined ? {} : { default: property.default }),
    ...(property.items === undefined ? {} : { items: migrateProperty(property.items) }),
    ...(property.minItems === undefined ? {} : { minItems: property.minItems }),
    ...(property.additive === true ? { "x-additive": true } : {}),
    ...(property.referenceRole === undefined ? {} : { "x-reference": property.referenceRole }),
    ...(property.commaShorthand === true ? { "x-encoding": "comma" as const } : {}),
  };
}

/**
 * Convert a legacy compact profile to an equivalent JSON Schema manifest.
 * Legacy strictness is made explicit: undeclared keys were errors at the top
 * level and silently dropped in nested objects; both become
 * `additionalProperties: false` (diagnosed, never dropped), unless the
 * component opted into opaque properties.
 */
export function migrateLegacySchema(legacy: LegacySchemaProfile): DocumentSchemaDefinition {
  const components: Record<string, ComponentDefinition> = {};
  for (const [tag, component] of Object.entries(legacy.components)) {
    components[tag] = {
      identity: component.identity,
      content: component.content,
      props: migrateObject(component.properties, component.allowOpaqueProperties === true),
      ...(component.regionOwnerProp === undefined
        ? {}
        : { regionOwner: component.regionOwnerProp }),
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    id: legacy.id,
    version: legacy.version,
    rootTag: legacy.rootTag,
    unknownComponents: legacy.unknownPolicy === "opaque" ? "preserve" : "reject",
    components,
  };
}

/** Compatibility importer: compile a legacy compact profile through the standard path. */
export function registerSchema(legacy: LegacySchemaProfile): SchemaProfile {
  const mismatched = Object.entries(legacy.components)
    .filter(([key, component]) => key !== component.tag)
    .map(([key]) =>
      diag("invalidSchema", `components.${key}`, "component key must equal its own tag"),
    );
  if (mismatched.length > 0) throw new DiagnosticError(mismatched);
  return defineDocumentSchema(migrateLegacySchema(legacy));
}
