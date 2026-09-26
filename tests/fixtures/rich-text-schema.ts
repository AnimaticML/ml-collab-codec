import { registerSchema } from "../../src/core/schema.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A small rich-text schema used across acceptance fixtures: paragraphs of mixed inline content. */
export const richTextSchema: SchemaProfile = registerSchema({
  id: "fixture.rich-text",
  version: "1.0.0",
  rootTag: "doc",
  unknownPolicy: "error",
  components: {
    doc: {
      tag: "doc",
      identity: "none",
      properties: {},
      content: { mode: "mixed", allowedTags: ["p", "emphasis", "comment"] },
    },
    p: {
      tag: "p",
      identity: "stable",
      properties: {
        opacity: { type: "number", default: 1 },
        title: { type: "string" },
        flag: { type: "boolean", default: false },
        tags: { type: "array", items: { type: "string" }, commaShorthand: true },
        style: {
          type: "object",
          properties: { color: { type: "string" }, weight: { type: "number" } },
        },
      },
      content: { mode: "mixed", allowedTags: ["emphasis", "comment"] },
    },
    emphasis: {
      tag: "emphasis",
      identity: "none",
      properties: {},
      content: { mode: "mixed" },
    },
    comment: {
      tag: "comment",
      identity: "stable",
      properties: { text: { type: "string", required: true }, author: { type: "string" } },
      content: { mode: "none" },
    },
  },
});
