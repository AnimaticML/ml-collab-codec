import type { ComponentSchema, PropertySchema, SchemaProfile } from "./schema.ts";
import type { JsonValue } from "./types.ts";

/**
 * A documented, dated capability entry (SPEC 12.3): what a provider/model/API
 * mode is believed to support, as of a retrieval date. This is a starting,
 * conservative record derived from the referenced provider documentation
 * [O1,G1,A1] at packaging time, not a live-verified guarantee; recheck before
 * relying on it, and prefer the opt-in live probes for current evidence.
 */
export interface ProviderCapability {
  readonly provider: "openai" | "gemini" | "anthropic";
  readonly model: string;
  readonly apiMode: string;
  readonly retrievedDate: string;
  /** false: every property must be listed `required`; optional fields become nullable instead. */
  readonly allowsOptionalOmission: boolean;
  readonly supportsRecursiveRefs: boolean;
  readonly supportedKeywords: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxProperties: number;
}

export const PROVIDER_CAPABILITIES: Readonly<
  Record<ProviderCapability["provider"], ProviderCapability>
> = {
  openai: {
    provider: "openai",
    model: "gpt-5-family",
    apiMode: "structured-outputs (strict json_schema)",
    retrievedDate: "2026-09-22",
    allowsOptionalOmission: false,
    supportsRecursiveRefs: true,
    supportedKeywords: new Set([
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "additionalProperties",
    ]),
    maxDepth: 10,
    maxProperties: 100,
  },
  gemini: {
    provider: "gemini",
    model: "gemini-2-family",
    apiMode: "responseSchema (OpenAPI 3.0 subset)",
    retrievedDate: "2026-09-22",
    allowsOptionalOmission: false,
    supportsRecursiveRefs: false,
    supportedKeywords: new Set(["type", "properties", "required", "items", "enum"]),
    maxDepth: 5,
    maxProperties: 64,
  },
  anthropic: {
    provider: "anthropic",
    model: "claude-family",
    apiMode: "tool input_schema (JSON Schema draft 2020-12 subset)",
    retrievedDate: "2026-09-22",
    allowsOptionalOmission: true,
    supportsRecursiveRefs: true,
    supportedKeywords: new Set([
      "type",
      "properties",
      "required",
      "items",
      "enum",
      "minItems",
      "additionalProperties",
    ]),
    maxDepth: 20,
    maxProperties: 200,
  },
};

export interface ExportResult {
  readonly profileId: string;
  readonly representation: "native" | "projected";
  readonly requestSchema: JsonValue;
  readonly generationEnforced: readonly string[];
  readonly runtimeOnlyChecks: readonly string[];
  readonly incompatibilities: readonly string[];
  readonly limits: { readonly maxDepth: number; readonly maxProperties: number };
}

function jsonType(type: PropertySchema["type"]): string {
  return type === "array" ? "array" : type === "object" ? "object" : type;
}

interface ExportContext {
  readonly capability: ProviderCapability;
  readonly incompatibilities: string[];
  readonly runtimeOnlyChecks: string[];
  depth: number;
  propertyCount: number;
}

function exportProperty(
  name: string,
  schema: PropertySchema,
  ctx: ExportContext,
  path: string,
): JsonValue {
  ctx.propertyCount += 1;
  if (ctx.propertyCount > ctx.capability.maxProperties) {
    ctx.incompatibilities.push(
      `${path}: exceeds provider property budget (${ctx.capability.maxProperties})`,
    );
  }
  if (schema.minItems !== undefined && !ctx.capability.supportedKeywords.has("minItems")) {
    ctx.runtimeOnlyChecks.push(
      `${path}: minItems is enforced only after decode (unsupported at generation time)`,
    );
  }
  const jsonSchema: Record<string, JsonValue> = { type: jsonType(schema.type) };
  if (schema.type === "array" && schema.items)
    jsonSchema["items"] = exportProperty(`${name}[]`, schema.items, ctx, `${path}[]`);
  if (schema.type === "object" && schema.properties) {
    const nested = exportProperties(schema.properties, ctx, path);
    jsonSchema["properties"] = nested.properties;
    jsonSchema["required"] = nested.required;
    jsonSchema["additionalProperties"] = false;
  }
  return jsonSchema;
}

function exportProperties(
  properties: Readonly<Record<string, PropertySchema>>,
  ctx: ExportContext,
  path: string,
): { properties: Record<string, JsonValue>; required: string[] } {
  const out: Record<string, JsonValue> = {};
  const required: string[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    const propPath = `${path}.${name}`;
    const propertySchema = exportProperty(name, schema, ctx, propPath) as Record<string, JsonValue>;
    const isRequired = schema.required === true;
    if (isRequired) {
      required.push(name);
      out[name] = propertySchema;
    } else if (ctx.capability.allowsOptionalOmission) {
      out[name] = propertySchema;
    } else {
      required.push(name);
      const baseType = propertySchema["type"] ?? "string";
      out[name] = { ...propertySchema, type: [baseType, "null"] as JsonValue };
    }
  }
  return { properties: out, required };
}

/** Export a single (non-recursive) component's schema natively for a provider. */
export function exportComponentSchema(
  component: ComponentSchema,
  capability: ProviderCapability,
): ExportResult {
  const ctx: ExportContext = {
    capability,
    incompatibilities: [],
    runtimeOnlyChecks: [],
    depth: 0,
    propertyCount: 0,
  };
  const { properties, required } = exportProperties(component.properties, ctx, component.tag);
  const requestSchema: JsonValue = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  return {
    profileId: `${capability.provider}:${capability.model}:${capability.apiMode}@${capability.retrievedDate}`,
    representation: "native",
    requestSchema,
    generationEnforced: ["type", "required", "additionalProperties"],
    runtimeOnlyChecks: ctx.runtimeOnlyChecks,
    incompatibilities: ctx.incompatibilities,
    limits: { maxDepth: capability.maxDepth, maxProperties: capability.maxProperties },
  };
}

/** A typed flat node-table projection (SPEC 12.2/S04/S06): the route for a recursion-incompatible profile. */
export function exportNodeTableSchema(
  profile: SchemaProfile,
  capability: ProviderCapability,
): ExportResult {
  const nodeSchema: JsonValue = {
    type: "object",
    properties: {
      wireRef: { type: "string" },
      id: { type: ["string", "null"] },
      tag: { type: "string", enum: Object.keys(profile.components) },
      props: { type: "object" },
      parentWireRef: { type: ["string", "null"] },
      orderKey: { type: "string" },
    },
    required: ["wireRef", "id", "tag", "props", "parentWireRef", "orderKey"],
    additionalProperties: false,
  };
  const requestSchema: JsonValue = {
    type: "object",
    properties: { nodes: { type: "array", items: nodeSchema } },
    required: ["nodes"],
    additionalProperties: false,
  };
  return {
    profileId: `${capability.provider}:${capability.model}:${capability.apiMode}@${capability.retrievedDate}`,
    representation: "projected",
    requestSchema,
    generationEnforced: ["type", "required", "additionalProperties"],
    runtimeOnlyChecks: [
      "acyclicity",
      "reference existence",
      "single-parent structure",
      "allowed nesting",
    ],
    incompatibilities: [],
    limits: { maxDepth: capability.maxDepth, maxProperties: capability.maxProperties },
  };
}

/** Choose native or projected export depending on the provider's recursion support (SPEC 12.2). */
export function exportForProvider(
  root: ComponentSchema,
  profile: SchemaProfile,
  capability: ProviderCapability,
): ExportResult {
  return capability.supportsRecursiveRefs
    ? exportComponentSchema(root, capability)
    : exportNodeTableSchema(profile, capability);
}
