import { canonicalJson } from "../core/change-codec.ts";
import { children } from "../core/table.ts";
import type { Table } from "../core/table.ts";
import type { PropertySchema } from "../core/schema.ts";
import { propertyAtPath } from "../core/schema.ts";
import type { CompositionInterface } from "./inference.ts";
import { fail, segments } from "./native.ts";

/** Exact contract identity for checking whether review evidence is still applicable. */
export function compositionReviewKey(table: Table, definition: string): string {
  const row = table.get(definition);
  if (row?.tag !== "compositionDefinition") fail(definition, "unknown definition");
  return canonicalJson([
    "composition/1",
    row.id,
    row.props,
    children(table, row.id).map(({ id, props }) => [id, props]),
  ]);
}

export interface CompositionPath {
  readonly scope: string;
  readonly path: string;
  readonly contract: PropertySchema;
}

/** A typed path resolves the same way whether entered directly or chosen from a suggestion. */
export function resolveCompositionPath(
  model: CompositionInterface,
  scope: string,
  path: string,
  intent: "use" | "create" = "use",
): CompositionPath | undefined {
  const parts = segments(path);
  const root = model.scopes.get(scope)?.components["values"]?.props;
  const contract = propertyAtPath(root, parts);
  if (contract === undefined) return undefined;
  if (intent === "create") fail(path, `path already exists in scope "${scope}"`);
  return { scope, path, contract };
}
