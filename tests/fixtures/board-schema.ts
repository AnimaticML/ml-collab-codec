import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A small numeric board: a grid of independently addressable, delta-editable cells. */
export const boardSchema: SchemaProfile = defineDocumentSchema({
  id: "fixture.board",
  version: "1.0.0",
  rootTag: "board",
  components: {
    board: {
      identity: "none",
      content: { mode: "element", allowedTags: ["cell"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    cell: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { value: { type: "integer", default: 0, "x-additive": true } },
        additionalProperties: false,
      },
    },
  },
});
