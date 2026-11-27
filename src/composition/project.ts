import { canonicalJson } from "../core/change-codec.ts";
import { children } from "../core/table.ts";
import type { Table, TableNode } from "../core/table.ts";
import type { ContentItem, JsonObject, JsonValue } from "../core/types.ts";
import { readFragment } from "./fragments.ts";
import { inferComposition, normalizeValues } from "./inference.ts";
import type { CompositionField, CompositionInterface } from "./inference.ts";
import { fail, readPath, record, segments, token } from "./native.ts";

export interface ProjectedBinding {
  readonly field: string;
  readonly path: string;
  readonly owner: string;
  readonly value: JsonValue | undefined;
}

export interface CompositionResult {
  readonly id: string;
  readonly definition: string;
  readonly owner: string;
  readonly values: JsonObject;
  readonly bindings: readonly ProjectedBinding[];
  readonly missing: readonly string[];
  readonly content: readonly ContentItem[];
}

function active(field: CompositionField, values: JsonObject): boolean {
  const condition = field.condition;
  if (condition === undefined) return true;
  const actual = readPath(values, condition.path);
  return actual !== undefined && canonicalJson(actual) === canonicalJson(condition.equals);
}

function resultContent(
  fragment: readonly ContentItem[],
  fields: readonly CompositionField[],
  values: JsonObject,
): ContentItem[] {
  return fragment.flatMap((item): ContentItem[] => {
    if (typeof item === "string") return [item];
    const props = { ...item.props };
    let content = resultContent(item.content ?? [], fields, values);
    for (const field of fields) {
      if (item.id === undefined || field.target !== item.id || field.property === undefined)
        continue;
      if (!active(field, values)) continue;
      const value = readPath(values, field.path);
      if (value === undefined) continue;
      if (field.property === "$include") {
        if (value === false) return [];
      } else if (field.property === "$content") {
        content = readFragment(value, field.id);
      } else {
        props[field.property] = value;
      }
    }
    return [{ ...item, props, content }];
  });
}

function bindingTargets(fragment: readonly ContentItem[]): Set<string> {
  const ids = new Set<string>();
  const visit = (items: readonly ContentItem[]): void => {
    for (const item of items) {
      if (typeof item === "string") continue;
      if (item.id !== undefined) {
        if (ids.has(item.id)) fail(item.id, "duplicate fragment node ID");
        ids.add(item.id);
      }
      visit(item.content ?? []);
    }
  };
  visit(fragment);
  return ids;
}

export interface CompositionOptions {
  /** Trusted exact implementation pins, available only in the host. */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** Host placement and reference-closure validation of complete results. */
  readonly validateResult?: (result: CompositionResult) => string | null;
}

export function prepareOccurrence(
  occurrence: TableNode,
  definition: TableNode,
  model: CompositionInterface,
  options: CompositionOptions,
) {
  if (occurrence.props["version"] !== definition.props["version"])
    fail(occurrence.id, "definition version mismatch");
  for (const [dependency, pin] of Object.entries(record(definition.props["dependencies"]))) {
    if (
      !Object.hasOwn(options.dependencies ?? {}, dependency) ||
      options.dependencies?.[dependency] !== pin
    )
      fail(occurrence.id, `unavailable dependency "${dependency}" at ${canonicalJson(pin)}`);
  }
  const scope = token(occurrence.props["scope"], occurrence.id);
  if (model.scopes.size > 0 && !model.scopes.has(scope))
    fail(occurrence.id, `unknown scope "${scope}"`);
  const fields = model.fields.filter((field) => field.scope === scope);
  const fragment = readFragment(definition.props["fragment"], definition.id);
  const targets = bindingTargets(fragment);
  const written = new Set<string>();
  for (const field of fields) {
    if (field.target === undefined) continue;
    if (!targets.has(field.target)) fail(field.id, "binding points outside the fixed fragment");
    const key = canonicalJson([field.target, field.property]);
    if (written.has(key)) fail(field.id, "duplicate binding target");
    written.add(key);
  }
  return (owner: TableNode): CompositionResult => {
    const values = normalizeValues(model, scope, record(owner.props["values"]), owner.id);
    for (const field of fields) {
      if (
        field.condition !== undefined &&
        readPath(values, field.condition.path) !== undefined &&
        !active(field, values) &&
        readPath(values, field.path) !== undefined &&
        !fields.some((use) => use.path === field.path && active(use, values))
      )
        fail(owner.id, `value "${field.path}" is excluded by the selected variant`);
    }
    const bindings = fields.map((field) => ({
      field: field.id,
      path: field.path,
      owner: owner.id,
      value: readPath(values, field.path),
    }));
    const required = fields
      .filter((field) => active(field, values))
      .flatMap((field) => [
        ...(field.required ? [field.path] : []),
        ...(field.requiredMembers ?? []),
      ]);
    const missing = [
      ...new Set(required.filter((path) => readPath(values, path) === undefined)),
    ].sort();
    const result = {
      id: canonicalJson([occurrence.id, owner.id]),
      definition: definition.id,
      owner: owner.id,
      values,
      bindings,
      missing,
      content: resultContent(fragment, fields, values),
    };
    const diagnostic = missing.length === 0 ? options.validateResult?.(result) : null;
    if (diagnostic != null) fail(owner.id, diagnostic);
    return result;
  };
}

export function compositionInputs(table: Table, id: string) {
  const occurrence = table.get(id);
  if (occurrence?.tag !== "compositionOccurrence") fail(id, "unknown occurrence");
  const definitionId = token(occurrence.props["definition"], id);
  const definition = table.get(definitionId);
  if (definition?.tag !== "compositionDefinition") fail(id, "missing definition");
  const items = children(table, id);
  const repeat = occurrence.props["repeat"];
  if (repeat !== undefined) {
    const path = token(repeat, id);
    // Repeat paths name the owned collection. The ordered child rows are its sole value carrier.
    if (occurrence.props["values"] !== undefined) fail(id, "repeated values belong to item rows");
    segments(path);
  } else if (items.length !== 0) fail(id, "item rows require a repeat path");
  return { occurrence, definition, owners: repeat === undefined ? [occurrence] : items };
}

/** Rebuild one occurrence directly from persisted definitions, carriers and item rows. */
export function projectComposition(
  table: Table,
  id: string,
  options: CompositionOptions = {},
): readonly CompositionResult[] {
  const { occurrence, definition, owners } = compositionInputs(table, id);
  return owners.map(
    prepareOccurrence(occurrence, definition, inferComposition(table, definition.id), options),
  );
}
