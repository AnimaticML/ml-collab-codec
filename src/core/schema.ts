import type { JsonValue } from "./types.ts";
import { type Diagnostic, DiagnosticError, diag } from "./diagnostics.ts";

/**
 * A compact, JSON-Schema-inspired property description. This is the library's
 * chosen dialect/profile: a constrained subset (SPEC section 2) sufficient for
 * scalars, arrays of scalars, nested objects, and component references, with
 * library annotations for defaults, additive (delta-capable) numbers, and
 * reference roles. Not every JSON Schema keyword is supported; unsupported
 * shapes are a registration-time capability error, not silent `any`.
 */
export type PropertyType = "string" | "number" | "boolean" | "array" | "object";

export interface PropertySchema {
  readonly type: PropertyType;
  /** JSON Schema `default` [J1]. Present iff the field is optional-with-default. */
  readonly default?: JsonValue;
  /** True marks a field as genuinely required (absent default does not imply required). */
  readonly required?: boolean;
  /** For type "array": element schema. Scalars only unless declared object items. */
  readonly items?: PropertySchema;
  /** For type "array": minimum length invariant, enforced by removeArrayItem and static validation. */
  readonly minItems?: number;
  /** For type "object": declared nested attribute-addressable properties. */
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  /** For type "number": participates in additive delta operations (SPEC 7.1). */
  readonly additive?: boolean;
  /** For type "string": marks this field as an internal-reference/domain ID. */
  readonly referenceRole?: "definition" | "reference";
  /** For type "array" of strings/numbers: permit the comma-shorthand encoding. */
  readonly commaShorthand?: boolean;
}

export type ContentMode = "mixed" | "element" | "none";

export interface ComponentSchema {
  readonly tag: string;
  /** Structural boundary: nodes of this tag receive a stable, addressable ID. */
  readonly identity: "stable" | "none";
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly content: {
    readonly mode: ContentMode;
    readonly allowedTags?: readonly string[];
  };
  /** Explicit opaque-extension escape hatch (SPEC 4.2/C11): retain unknown properties verbatim. */
  readonly allowOpaqueProperties?: boolean;
  /** SPEC 13: a node of this tag is a homogeneous-visibility region owned by this string property's value. */
  readonly regionOwnerProp?: string;
}

export interface SchemaProfile {
  readonly id: string;
  readonly version: string;
  readonly rootTag: string;
  readonly components: Readonly<Record<string, ComponentSchema>>;
  /** "opaque" preserves unknown tags/properties verbatim instead of erroring. */
  readonly unknownPolicy: "error" | "opaque";
}

function validateDefault(schemaPath: string, property: PropertySchema): Diagnostic[] {
  if (property.default === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  const value = property.default;
  const matches =
    (property.type === "string" && typeof value === "string") ||
    (property.type === "number" && typeof value === "number") ||
    (property.type === "boolean" && typeof value === "boolean") ||
    (property.type === "array" && Array.isArray(value)) ||
    (property.type === "object" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value));
  if (!matches) {
    diagnostics.push(
      diag(
        "invalidValue",
        schemaPath,
        `default value does not match declared type ${property.type}`,
      ),
    );
  }
  return diagnostics;
}

function validateComponentSchema(component: ComponentSchema, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (component.identity === "stable" && component.tag.length === 0) {
    diagnostics.push(diag("invalidValue", path, "component tag must be non-empty"));
  }
  for (const [name, property] of Object.entries(component.properties)) {
    diagnostics.push(...validateDefault(`${path}.properties.${name}`, property));
    if (property.type === "object" && property.properties) {
      for (const [nestedName, nested] of Object.entries(property.properties)) {
        diagnostics.push(
          ...validateDefault(`${path}.properties.${name}.properties.${nestedName}`, nested),
        );
      }
    }
  }
  return diagnostics;
}

/**
 * Register a schema profile: validates the profile itself (declared defaults
 * must match their declared types, tags must be usable). Throws a
 * {@link DiagnosticError} on an invalid profile.
 */
export function registerSchema(profile: SchemaProfile): SchemaProfile {
  const diagnostics: Diagnostic[] = [];
  if (!(profile.rootTag in profile.components)) {
    diagnostics.push(
      diag("invalidValue", "rootTag", `rootTag "${profile.rootTag}" has no component schema`),
    );
  }
  for (const [tag, component] of Object.entries(profile.components)) {
    if (tag !== component.tag) {
      diagnostics.push(
        diag("invalidValue", `components.${tag}`, "component key must equal its own tag"),
      );
    }
    diagnostics.push(...validateComponentSchema(component, `components.${tag}`));
  }
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  return profile;
}

export function getComponentSchema(
  profile: SchemaProfile,
  tag: string,
): ComponentSchema | undefined {
  return profile.components[tag];
}
