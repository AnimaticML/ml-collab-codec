import type { JsonObject, JsonValue } from "./types.ts";

/**
 * Compiled, read-only schema descriptors. Applications author schemas as
 * JSON Schema 2020-12 manifests (`defineDocumentSchema`, see
 * `schema-definition.ts`) or import the legacy compact profile
 * (`registerSchema`); both compile to this one internal form, which every
 * codec, validation, editing, and export path reads.
 */
export type ValueType = "string" | "number" | "integer" | "boolean" | "array" | "object";

/** Policy for keys an object schema does not declare. */
export type AdditionalPolicy =
  | { readonly kind: "reject" }
  | { readonly kind: "preserve" }
  | { readonly kind: "schema"; readonly schema: PropertySchema };

export interface PropertySchema {
  /** Absent when the value is constrained only by `enum`/`const`/variants. */
  readonly type?: ValueType;
  readonly default?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  /** Array element schema. */
  readonly items?: PropertySchema;
  /** Object members and their policy. */
  readonly properties?: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
  readonly additional?: AdditionalPolicy;
  /**
   * `oneOf`/`anyOf`: the value is validated by the standard validator as a
   * whole; no nested null/default normalization happens inside it.
   */
  readonly variants?: boolean;
  /** `x-additive`: accepts relative `delta` operations (safe integers only). */
  readonly additive?: boolean;
  /** `x-reference`: domain reference role for integrity checks. */
  readonly reference?: "definition" | "reference";
  /** `x-encoding: "comma"`: a primitive array may use the comma attribute shorthand. */
  readonly commaShorthand?: boolean;
}

export type ContentMode = "mixed" | "element" | "none";

export interface ComponentSchema {
  readonly tag: string;
  /** Structural boundary: nodes of this tag carry a persistent, addressable ID. */
  readonly identity: "stable" | "none";
  readonly content: { readonly mode: ContentMode; readonly allowedTags?: readonly string[] };
  /** Root object descriptor of the component's properties. */
  readonly props: PropertySchema;
  /** Shortcut for `props.properties` (declared top-level properties). */
  readonly properties: Readonly<Record<string, PropertySchema>>;
  /** SPEC 13: a node of this tag is a visibility region owned by this string property. */
  readonly regionOwnerProp?: string;
}

export interface SchemaProfile {
  readonly id: string;
  readonly version: string;
  readonly rootTag: string;
  readonly components: Readonly<Record<string, ComponentSchema>>;
  /** Components whose tag the schema does not declare: rejected, or preserved opaquely. */
  readonly unknownComponents: "reject" | "preserve";
  /** Standard JSON Schema of each component's props, with `$defs`, for the validator. */
  readonly standardProps: Readonly<Record<string, JsonObject>>;
  /** Shared local definitions (`#/$defs/...`). */
  readonly definitions: JsonObject;
}

export function getComponentSchema(
  profile: SchemaProfile,
  tag: string,
): ComponentSchema | undefined {
  return Object.hasOwn(profile.components, tag) ? profile.components[tag] : undefined;
}

/** Descend a property path (object keys and array indexes) through descriptors. */
export function propertyAtPath(
  root: PropertySchema | undefined,
  path: readonly (string | number)[],
): PropertySchema | undefined {
  let cursor = root;
  for (const segment of path) {
    if (cursor === undefined || cursor.variants === true) return undefined;
    if (typeof segment === "number") cursor = cursor.items;
    else {
      const declared = cursor.properties?.[segment];
      const additional = cursor.additional;
      cursor =
        declared !== undefined && Object.hasOwn(cursor.properties ?? {}, segment)
          ? declared
          : additional?.kind === "schema"
            ? additional.schema
            : undefined;
    }
  }
  return cursor;
}
