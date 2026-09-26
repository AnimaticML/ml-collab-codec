import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A tiny card game: a public table and per-player private hands (SPEC 13). */
export const hiddenHandSchema: SchemaProfile = defineDocumentSchema({
  id: "fixture.hidden-hand",
  version: "1.0.0",
  rootTag: "game",
  components: {
    game: {
      identity: "none",
      content: { mode: "element", allowedTags: ["table", "hand"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    table: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["card"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    hand: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["card"] },
      regionOwner: "owner",
      props: {
        type: "object",
        properties: { owner: { type: "string" } },
        required: ["owner"],
        additionalProperties: false,
      },
    },
    card: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { rank: { type: "string" }, suit: { type: "string" } },
        required: ["rank", "suit"],
        additionalProperties: false,
      },
    },
  },
});
