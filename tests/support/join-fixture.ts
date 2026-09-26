import { SequenceAllocator } from "../../src/core/identity.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";
import { createAllocator, fromTable, TEXT_TAG, toTable } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";

/** A persisted-root rich-text schema for join/history tests (root id, anonymous inline nodes, arrays). */
export const joinSchema: SchemaProfile = defineDocumentSchema({
  id: "fixture.join",
  version: "2.1.0",
  rootTag: "doc",
  components: {
    doc: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["p"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    p: {
      identity: "stable",
      content: { mode: "mixed", allowedTags: ["emphasis"] },
      props: {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    },
    emphasis: {
      identity: "none",
      content: { mode: "mixed" },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
  },
});

export const joinRef = { id: joinSchema.id, version: joinSchema.version };

export function joinDoc(): Table {
  const parsed = parseDocument(
    `<doc id="d1"><p id="p1">hello <emphasis>big</emphasis> world</p><p id="p2">second</p><p id="p3">third</p></doc>`,
    joinSchema,
  );
  if (!parsed.ok) throw new Error("fixture parse failed");
  return toTable(parsed.value, createAllocator());
}

/** The first text run directly under `parent`. */
export function firstRun(table: Table, parent: string): string {
  const run = table.get(parent)?.children.find((id) => table.get(id)?.tag === TEXT_TAG);
  if (run === undefined) throw new Error(`no text run under ${parent}`);
  return run;
}

/** Comparable effective content of a table (root id and schema interpretation included). */
export function content(table: Table): unknown {
  return fromTable(table, joinSchema.id, joinSchema.version);
}

export function allocator(replica: string, lastSeq = 0): SequenceAllocator {
  return SequenceAllocator.ephemeral(replica, lastSeq);
}

/** A JSON round-trip (the serialized boundary a store or transport imposes). */
export function viaJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A serialized snapshot opened for deliberate corruption in tests. */
export interface MutableRows {
  rows: { id: string; tag: string; props: Record<string, unknown>; children: string[] }[];
}
