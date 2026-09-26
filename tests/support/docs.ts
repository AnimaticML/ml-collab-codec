import type { JsonObject } from "../../src/core/types.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";
import type { Table, TableNode } from "../../src/core/table.ts";
import { makeRow, ROOT_ID, TEXT_TAG, textOf } from "../../src/core/table.ts";
import { tableFrom } from "./gen.ts";

/** Root paragraph with one text run "t". */
export function textDoc(text: string, runId = "t"): Table {
  return tableFrom([
    makeRow(ROOT_ID, "p", {}, null, [runId], false),
    makeRow(runId, TEXT_TAG, { value: text }, ROOT_ID, [], false),
  ]);
}

/** Root list whose `items` array holds ordinary JSON occurrences (no ids). */
export function listDoc(props: JsonObject): Table {
  return tableFrom([makeRow(ROOT_ID, "list", props, null, [], false)]);
}

/** Root container with element children, each a node with the given id and label. */
export function childrenDoc(labels: readonly string[]): Table {
  const rows: TableNode[] = labels.map((label) =>
    makeRow(label, "item", { label }, ROOT_ID, [], true),
  );
  return tableFrom([makeRow(ROOT_ID, "list", {}, null, labels, false), ...rows]);
}

/** Visible text of all runs under `parent`, in document order. */
export function textUnder(table: Table, parent = ROOT_ID): string {
  const row = table.get(parent);
  if (row === undefined) return "";
  if (row.tag === TEXT_TAG) return textOf(row);
  return row.children.map((child) => textUnder(table, child)).join("");
}

export function items(table: Table, node = ROOT_ID): unknown {
  return table.get(node)?.props["items"];
}

/** Trusted schema with an invariant-bound collection (minItems = 1) and an additive counter. */
export const listSchema: SchemaProfile = defineDocumentSchema({
  id: "fixture.list",
  version: "1.0.0",
  rootTag: "list",
  components: {
    list: {
      identity: "none",
      content: { mode: "element", allowedTags: ["item"] },
      props: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" }, minItems: 1 },
          count: { type: "integer", "x-additive": true, default: 0 },
          x: { type: "number", default: 0 },
        },
        additionalProperties: false,
      },
    },
    item: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
});
