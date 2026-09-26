import type { JsonValue } from "./types.ts";
import type { Change } from "./change.ts";
import { subtreeIds } from "./change.ts";
import type { ComponentSchema, PropertySchema, SchemaProfile } from "./schema.ts";
import { getComponentSchema, propertyAtPath } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { normalizeComponentProps } from "./normalize.ts";
import { normalizeDocument } from "./document-check.ts";
import type { Table, TableNode } from "./table.ts";
import { fromTable, ROOT_ID, TEXT_TAG, textOf } from "./table.ts";

/**
 * Full reference validation of an operational table against a schema: the
 * same effective-value contract as every other entry path (an omitted value,
 * an explicit null, and the declared default are the same state).
 */
export function validateTable(table: Table, profile: SchemaProfile): Diagnostic[] {
  return [
    ...normalizeDocument(fromTable(table, profile.id, profile.version).root, profile).diagnostics,
  ];
}

/** Whether a descriptor subtree contains any domain reference role (cycle-safe). */
function hasRoles(schema: PropertySchema | undefined, seen = new Set<PropertySchema>()): boolean {
  if (schema === undefined || seen.has(schema)) return false;
  seen.add(schema);
  if (schema.reference !== undefined) return true;
  const extra = schema.additional?.kind === "schema" ? schema.additional.schema : undefined;
  return (
    hasRoles(schema.items, seen) ||
    hasRoles(extra, seen) ||
    Object.values(schema.properties ?? {}).some((p) => hasRoles(p, seen))
  );
}

function componentHasRoles(profile: SchemaProfile, tag: string | undefined): boolean {
  return tag !== undefined && hasRoles(getComponentSchema(profile, tag)?.props);
}

/** Changes that can alter the set of domain definitions or references. */
function touchesRoles(
  profile: SchemaProfile,
  change: Change,
  before: Table,
  after: Table,
): boolean {
  switch (change.kind) {
    case "set":
    case "delta":
    case "arrayInsert":
    case "arrayDelete":
    case "arrayMove": {
      const tag = after.get(change.node)?.tag;
      const props = getComponentSchema(profile, tag ?? "")?.props;
      // A write at or above a path whose subtree declares roles can change them.
      for (let i = 0; i <= change.path.length; i += 1)
        if (hasRoles(propertyAtPath(props, change.path.slice(0, i)))) return true;
      return false;
    }
    case "nodeInsert":
    case "nodeDelete":
      return [...subtreeIds(change.subtree)].some((id) =>
        componentHasRoles(profile, (before.get(id) ?? after.get(id))?.tag),
      );
    case "setTag":
      return componentHasRoles(profile, change.before) || componentHasRoles(profile, change.after);
    default:
      return false;
  }
}

function referenceIssues(table: Table, profile: SchemaProfile): Diagnostic[] {
  const definitions = new Set<string>();
  const references: { value: string; path: string }[] = [];
  const walk = (
    schema: PropertySchema | undefined,
    value: JsonValue | undefined,
    path: string,
  ): void => {
    if (schema === undefined || value === undefined || schema.variants === true) return;
    if (typeof value === "string" && schema.reference === "definition") definitions.add(value);
    if (typeof value === "string" && schema.reference === "reference")
      references.push({ value, path });
    if (Array.isArray(value))
      value.forEach((item: JsonValue, i) => walk(schema.items, item, `${path}[${i}]`));
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value))
        walk(propertyAtPath(schema, [key]), item, `${path}.${key}`);
  };
  for (const row of table.values())
    if (componentHasRoles(profile, row.tag))
      walk(getComponentSchema(profile, row.tag)?.props, row.props, `${row.id}.props`);
  return references
    .filter((reference) => !definitions.has(reference.value))
    .map((reference) =>
      diag(
        "danglingReference",
        reference.path,
        `reference "${reference.value}" has no matching definition`,
      ),
    );
}

function affectedRows(changes: readonly Change[], table: Table): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | undefined | null): void =>
    void (id !== undefined && id !== null && ids.add(id));
  for (const change of changes) {
    if ("node" in change) add(change.node);
    if (change.kind === "nodeInsert") for (const id of subtreeIds(change.subtree)) add(id);
    if (change.kind === "nodeInsert" || change.kind === "nodeDelete") add(change.parent);
    if (change.kind === "nodeMove") [change.fromParent, change.toParent].forEach(add);
    if (change.kind === "split" || change.kind === "merge")
      [change.other, change.parent].forEach(add);
  }
  for (const id of [...ids]) {
    const row = table.get(id);
    if (row?.tag === TEXT_TAG) add(row.parentId);
  }
  return ids;
}

function checkChildren(
  table: Table,
  row: TableNode,
  component: ComponentSchema | undefined,
  out: Diagnostic[],
): void {
  const mode = component?.content.mode ?? "mixed";
  const allowed = component?.content.allowedTags;
  for (const id of row.children) {
    const child = table.get(id);
    if (child === undefined) continue;
    if (child.tag === TEXT_TAG) {
      if (mode !== "mixed" && textOf(child).length > 0)
        out.push(diag("invalidNesting", `${row.id}`, `<${row.tag}> does not accept text`));
    } else if (mode === "none")
      out.push(diag("invalidNesting", `${row.id}`, `<${row.tag}> does not accept content`));
    else if (allowed !== undefined && !allowed.includes(child.tag))
      out.push(
        diag("invalidNesting", `${row.id}`, `<${child.tag}> is not allowed inside <${row.tag}>`),
      );
  }
}

function checkRow(table: Table, profile: SchemaProfile, row: TableNode, out: Diagnostic[]): void {
  if (row.tag === TEXT_TAG) return;
  const component = getComponentSchema(profile, row.tag);
  if (row.id === ROOT_ID && row.tag !== profile.rootTag)
    out.push(diag("invalidValue", "$", `root must be <${profile.rootTag}>`));
  if (component === undefined && profile.unknownComponents === "reject")
    out.push(diag("unknownTag", row.id, `unknown component <${row.tag}>`));
  if (component?.identity === "stable" && row.id !== ROOT_ID && !row.persisted)
    out.push(diag("missingRequired", row.id, `<${row.tag}> requires a persistent id`));
  out.push(...normalizeComponentProps(profile, row.tag, row.props, `${row.id}.props`).diagnostics);
  checkChildren(table, row, component, out);
}

/**
 * Incremental schema validation of a final candidate: checks every row a
 * change can affect (its props, identity, and the content rules of affected
 * parents) and rescans domain references only when a change can alter them.
 * Assumes the pre-change state was valid; differential-tested against
 * {@link validateTable}.
 */
export function incrementalIssues(
  profile: SchemaProfile,
  before: Table,
  candidate: Table,
  changes: readonly Change[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const id of affectedRows(changes, candidate)) {
    const row = candidate.get(id);
    if (row !== undefined) checkRow(candidate, profile, row, out);
  }
  if (changes.some((change) => touchesRoles(profile, change, before, candidate)))
    out.push(...referenceIssues(candidate, profile));
  return out;
}
