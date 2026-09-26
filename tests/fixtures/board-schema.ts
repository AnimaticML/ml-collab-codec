import { registerSchema } from "../../src/core/schema.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";

/** A small numeric board: a grid of independently addressable, delta-editable cells. */
export const boardSchema: SchemaProfile = registerSchema({
  id: "fixture.board",
  version: "1.0.0",
  rootTag: "board",
  unknownPolicy: "error",
  components: {
    board: {
      tag: "board",
      identity: "none",
      properties: {},
      content: { mode: "element", allowedTags: ["cell"] },
    },
    cell: {
      tag: "cell",
      identity: "stable",
      properties: { value: { type: "number", default: 0, additive: true } },
      content: { mode: "none" },
    },
  },
});
