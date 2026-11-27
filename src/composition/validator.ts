import type { CandidateValidator } from "../core/invariants.ts";
import { summarize } from "../core/summary.ts";
import type { Table, TableNode } from "../core/table.ts";
import { CompositionIndex } from "./indexed.ts";
import { inferComposition } from "./inference.ts";
import { CompositionError } from "./native.ts";
import type { CompositionOptions } from "./project.ts";

function affected(
  row: TableNode | undefined,
  table: Table,
  definitions: Set<string>,
  occurrences: Set<string>,
): void {
  if (row?.tag === "compositionDefinition") definitions.add(row.id);
  if (row?.tag === "compositionOccurrence") occurrences.add(row.id);
  if (
    row?.tag === "compositionField" &&
    row.parentId !== null &&
    table.get(row.parentId)?.tag === "compositionDefinition"
  )
    definitions.add(row.parentId);
  if (
    row?.tag === "compositionItem" &&
    row.parentId !== null &&
    table.get(row.parentId)?.tag === "compositionOccurrence"
  )
    occurrences.add(row.parentId);
}

/** Install alongside the host schema validator so direct edits follow the same contracts. */
export function compositionValidator(options: CompositionOptions = {}): CandidateValidator {
  const checked = new WeakSet<Table>();
  const index = new CompositionIndex(options);
  return (table, changes, before) => {
    if (checked.has(table)) return null;
    const definitions = new Set<string>();
    const occurrences = new Set<string>();
    const initial = !checked.has(before);
    if (initial) {
      for (const row of table.values()) affected(row, table, definitions, occurrences);
    } else {
      for (const id of summarize(before, table, changes).candidates) {
        affected(before.get(id), before, definitions, occurrences);
        affected(table.get(id), table, definitions, occurrences);
      }
      if (definitions.size > 0)
        for (const row of table.values()) {
          const definition = row.props["definition"];
          if (
            row.tag === "compositionOccurrence" &&
            typeof definition === "string" &&
            definitions.has(definition)
          )
            occurrences.add(row.id);
        }
    }
    try {
      for (const id of definitions)
        if (table.get(id)?.tag === "compositionDefinition") inferComposition(table, id);
      for (const id of occurrences)
        if (table.get(id)?.tag === "compositionOccurrence") index.project(table, id);
      checked.add(table);
      return null;
    } catch (error) {
      if (error instanceof CompositionError) return error.message;
      throw error;
    }
  };
}
