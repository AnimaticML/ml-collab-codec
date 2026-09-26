// Fresh-process inversion (R10/R36): reads serialized records and a post-state
// on stdin, derives the inverse from the records alone, and prints the state.
import { applyChanges, decodeChanges, invertChanges, canonicalJson } from "../../src/index.ts";
import type { TableNode } from "../../src/index.ts";

const input = JSON.parse(await Bun.stdin.text()) as { rows: TableNode[]; records: unknown };
const table = new Map(input.rows.map((row) => [row.id, row]));
const restored = applyChanges(table, invertChanges(decodeChanges(input.records)));
const rows = [...restored.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
process.stdout.write(canonicalJson(rows));
