import Ajv2020 from "ajv/dist/2020.js";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";
import type { JsonObject, JsonValue } from "../../src/core/types.ts";

/**
 * A recursive mixed-content outline used by the provider tests: sections
 * nest, paragraphs mix text with anonymous emphasis, notes are stable and
 * reference sections, and fields carry constraints that providers enforce to
 * different degrees.
 */
export const outlineSchema: SchemaProfile = defineDocumentSchema({
  id: "fixture.outline",
  version: "1.0.0",
  rootTag: "outline",
  $defs: {
    label: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 40 },
  },
  components: {
    outline: {
      identity: "none",
      content: { mode: "element", allowedTags: ["section"] },
      props: {
        type: "object",
        properties: { title: { type: "string", minLength: 1 } },
        required: ["title"],
        additionalProperties: false,
      },
    },
    section: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["section", "para", "note"] },
      props: {
        type: "object",
        properties: {
          heading: { type: "string" },
          slug: { type: "string", pattern: "^[a-z][a-z0-9-]*$", "x-reference": "definition" },
          level: { type: "integer", minimum: 1, maximum: 6, default: 1 },
          tags: { type: "array", items: { $ref: "#/$defs/label" }, minItems: 2 },
          draft: { type: "boolean", default: false },
        },
        required: ["heading"],
        additionalProperties: false,
      },
    },
    para: {
      identity: "none",
      content: { mode: "mixed", allowedTags: ["em"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    em: {
      identity: "none",
      content: { mode: "mixed" },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    note: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: {
          target: { type: "string", "x-reference": "reference" },
          text: { type: "string" },
        },
        required: ["target", "text"],
        additionalProperties: false,
      },
    },
  },
});

/** A second independent validator (Ajv, 2020-12) so the library's own validator is not its own oracle. */
export function independentValidator(schema: JsonObject): (value: JsonValue) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  return ajv.compile(schema) as (value: JsonValue) => boolean;
}
