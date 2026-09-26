import type { Change } from "./change.ts";
import type { PropertySchema, SchemaProfile } from "./schema.ts";
import type { Table } from "./table.ts";
import { TEXT_TAG } from "./table.ts";

/**
 * A trusted final-candidate check. It sees the complete candidate and the
 * effective primitives; it returns a safe reason string to reject, or null.
 * Validators are registered by code, never loaded from documents.
 */
export type CandidateValidator = (candidate: Table, changes: readonly Change[]) => string | null;

function propertyAt(
  schema: PropertySchema | undefined,
  path: readonly (string | number)[],
): PropertySchema | undefined {
  let cursor = schema;
  for (const segment of path) {
    if (cursor === undefined) return undefined;
    cursor = typeof segment === "number" ? cursor.items : cursor.properties?.[segment];
  }
  return cursor;
}

function touchedNodes(changes: readonly Change[]): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    if ("node" in change) ids.add(change.node);
    if (change.kind === "nodeInsert") ids.add(change.subtree.id);
  }
  return ids;
}

/**
 * Trusted schema invariants on the final candidate (SPEC 7, v3 §5.1):
 * array `minItems` comes from the schema, never from a client payload, and
 * relative deltas are accepted only on fields declared `additive`.
 */
export function schemaInvariants(profile: SchemaProfile): CandidateValidator {
  return (candidate, changes) => {
    for (const change of changes) {
      if (change.kind !== "delta") continue;
      const tag = candidate.get(change.node)?.tag ?? "";
      const [prop, ...rest] = change.path;
      const property = propertyAt(profile.components[tag]?.properties[String(prop)], rest);
      if (property?.additive !== true) return "delta targets a field that is not declared additive";
    }
    for (const id of touchedNodes(changes)) {
      const row = candidate.get(id);
      if (row === undefined || row.tag === TEXT_TAG) continue;
      const component = profile.components[row.tag];
      if (component === undefined) return "unknown component";
      for (const [name, property] of Object.entries(component.properties)) {
        const value = row.props[name];
        if (
          property.minItems !== undefined &&
          Array.isArray(value) &&
          value.length < property.minItems
        )
          return `${name} must keep at least ${property.minItems} items`;
      }
    }
    return null;
  };
}
