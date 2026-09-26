import { registerSchema } from "../../src/core/schema.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A tiny card game: a public table and per-player private hands (SPEC 13). */
export const hiddenHandSchema: SchemaProfile = registerSchema({
  id: "fixture.hidden-hand",
  version: "1.0.0",
  rootTag: "game",
  unknownPolicy: "error",
  components: {
    game: {
      tag: "game",
      identity: "none",
      properties: {},
      content: { mode: "element", allowedTags: ["table", "hand"] },
    },
    table: {
      tag: "table",
      identity: "stable",
      properties: {},
      content: { mode: "element", allowedTags: ["card"] },
    },
    hand: {
      tag: "hand",
      identity: "stable",
      properties: { owner: { type: "string", required: true } },
      regionOwnerProp: "owner",
      content: { mode: "element", allowedTags: ["card"] },
    },
    card: {
      tag: "card",
      identity: "stable",
      properties: {
        rank: { type: "string", required: true },
        suit: { type: "string", required: true },
      },
      content: { mode: "none" },
    },
  },
});
