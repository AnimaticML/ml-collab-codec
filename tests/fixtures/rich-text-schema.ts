import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A small rich-text schema used across acceptance fixtures: paragraphs of mixed inline content. */
export const richTextSchema: SchemaProfile = defineDocumentSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "fixture.rich-text",
  version: "1.0.0",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: "mixed", allowedTags: ["p", "emphasis", "comment"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    p: {
      identity: "stable",
      content: { mode: "mixed", allowedTags: ["emphasis", "comment"] },
      props: {
        type: "object",
        properties: {
          opacity: { type: "number", default: 1 },
          title: { type: "string" },
          flag: { type: "boolean", default: false },
          tags: { type: "array", items: { type: "string" }, "x-encoding": "comma" },
          style: {
            type: "object",
            properties: { color: { type: "string" }, weight: { type: "number" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    emphasis: {
      identity: "none",
      content: { mode: "mixed" },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    comment: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { text: { type: "string" }, author: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
});
