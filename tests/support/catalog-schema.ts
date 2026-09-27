import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { DocumentSchemaDefinition } from "../../src/core/schema-definition.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/**
 * A catalog domain for the schema/validation families (MR01–MR07): nested
 * objects, arrays of objects, primitive arrays, enums/consts, defaults,
 * required fields, recursive groups, domain references, a strict component
 * and an explicitly extensible one.
 */
export const catalogDefinition: DocumentSchemaDefinition = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "fixture.catalog",
  version: "1.0.0",
  rootTag: "catalog",
  $defs: {
    row: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        qty: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  components: {
    catalog: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["item", "group", "ref", "ext"] },
      props: {
        type: "object",
        properties: {
          title: { type: "string" },
          tags: { type: "array", items: { type: "string" }, maxItems: 3 },
          limits: {
            type: "object",
            properties: {
              low: { type: "integer", minimum: 0 },
              band: {
                type: "object",
                properties: { width: { type: "number", maximum: 10 } },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          rows: { type: "array", items: { $ref: "#/$defs/row" }, minItems: 1 },
          mode: { enum: ["draft", "final"] },
          kind: { const: "catalog" },
          flag: { type: "boolean", default: false },
          label: { type: "string", default: "untitled" },
          count: { type: "integer", default: 0, "x-additive": true },
          shape: {
            oneOf: [
              {
                type: "object",
                properties: { r: { type: "number" } },
                required: ["r"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { w: { type: "number" } },
                required: ["w"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    group: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["item", "group"] },
      props: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
    item: {
      identity: "stable",
      content: { mode: "mixed" },
      props: {
        type: "object",
        properties: { sku: { type: "string", "x-reference": "definition" } },
        additionalProperties: false,
      },
    },
    ref: {
      identity: "none",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { target: { type: "string", "x-reference": "reference" } },
        required: ["target"],
        additionalProperties: false,
      },
    },
    ext: {
      identity: "none",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { note: { type: "string" } },
        additionalProperties: true,
      },
    },
  },
};

export const catalogSchema: SchemaProfile = defineDocumentSchema(catalogDefinition);

/** A valid catalog source (JSON blocks carry structured values). */
export const CATALOG_SOURCE = [
  `<catalog id="c1" title="Parts">`,
  `<script type="application/json">{"rows":[{"name":"bolt","qty":2},{"name":"bolt","qty":2}],"tags":["a","a"],"limits":{"low":1,"band":{"width":3}}}</script>`,
  `<group id="g1"><group id="g2"><item id="i1" sku="bolt-1">Bolt</item></group></group>`,
  `<ref target="bolt-1"></ref>`,
  `</catalog>`,
].join("");
