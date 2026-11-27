import type { Table } from "../core/table.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { isJsonObject } from "../core/types.ts";
import { fail, segments } from "./native.ts";
import type { ActionRead } from "../core/action-guards.ts";
import { planSemanticAction } from "./actions.ts";
import type { ActionChecks, SemanticPlan } from "./actions.ts";

function renameValues(
  values: JsonObject,
  parent: readonly string[],
  oldName: string,
  newName: string,
): JsonObject {
  const [key, ...rest] = parent;
  if (key !== undefined) {
    const branch = values[key];
    if (!isJsonObject(branch)) return values;
    const changed = renameValues(branch, rest, oldName, newName);
    return changed === branch ? values : { ...values, [key]: changed };
  }
  if (Object.hasOwn(values, newName)) fail(newName, "data path already exists");
  const { [oldName]: value, ...remaining } = values;
  if (value === undefined) return values;
  return { ...remaining, [newName]: value };
}

function renameContract(
  schema: JsonObject,
  keys: readonly string[],
  oldName: string,
  newName: string,
): JsonObject {
  const properties = schema["properties"];
  if (!isJsonObject(properties)) return schema;
  const [key, ...rest] = keys;
  if (key === undefined || !Object.hasOwn(properties, key)) return schema;
  const next = properties[key];
  return rest.length === 0
    ? {
        ...schema,
        properties: renameValues(properties, [], oldName, newName),
        ...(Array.isArray(schema["required"])
          ? {
              required: schema["required"].map((name: JsonValue) =>
                name === oldName ? newName : name,
              ),
            }
          : {}),
      }
    : isJsonObject(next)
      ? {
          ...schema,
          properties: { ...properties, [key]: renameContract(next, rest, oldName, newName) },
        }
      : schema;
}

/** Rename one path segment in its existing parent. The installed validator checks the final contract. */
export function planCompositionRename(
  table: Table,
  definition: string,
  scope: string,
  from: string,
  newName: string,
  checks: ActionChecks = {},
): SemanticPlan {
  const parts = segments(from);
  if (segments(newName).length !== 1) fail(newName, "expected one new path segment");
  const oldName = parts.pop();
  if (oldName === undefined || oldName === newName) fail(from, "rename must change the path");
  const destination = [...parts, newName].join(".");
  const below = (path: string, prefix: string): boolean =>
    path === prefix || path.startsWith(`${prefix}.`);
  const row = table.get(definition);
  if (row?.tag !== "compositionDefinition") fail(definition, "unknown definition");
  const reads: ActionRead[] = [{ node: definition }];
  const writes: { node: string; property: string; value: JsonValue }[] = [];
  for (const id of row.children) {
    const field = table.get(id);
    if (field === undefined) continue;
    for (const property of ["scope", "path", "contract", "when"])
      reads.push({ node: id, property });
    const { path, contract } = field.props;
    if (field.props["scope"] !== scope || typeof path !== "string") continue;
    if (below(path, destination)) fail(id, "semantic path already exists");
    if (below(path, from))
      writes.push({ node: id, property: "path", value: destination + path.slice(from.length) });
    const when = field.props["when"];
    if (isJsonObject(when) && typeof when["path"] === "string" && below(when["path"], from))
      writes.push({
        node: id,
        property: "when",
        value: { ...when, path: destination + when["path"].slice(from.length) },
      });
    if (isJsonObject(contract) && below(from, path) && from !== path) {
      const nested = from.slice(path.length + 1).split(".");
      const value = renameContract(contract, nested, oldName, newName);
      if (value !== contract) writes.push({ node: id, property: "contract", value });
    }
  }
  if (writes.length === 0) fail(from, "unknown semantic path");
  for (const occurrence of table.values()) {
    if (
      occurrence.tag !== "compositionOccurrence" ||
      occurrence.props["definition"] !== definition ||
      occurrence.props["scope"] !== scope
    )
      continue;
    reads.push({ node: occurrence.id });
    for (const id of [occurrence.id, ...occurrence.children]) {
      reads.push({ node: id, property: "values" });
      const values = table.get(id)?.props["values"];
      if (!isJsonObject(values)) continue;
      const value = renameValues(values, parts, oldName, newName);
      if (value !== values) writes.push({ node: id, property: "values", value });
    }
  }
  return planSemanticAction(
    table,
    "composition.rename/1",
    reads,
    {
      rule: "rename",
      apply: (builder) => {
        for (const { node, property, value } of writes) builder.set(node, property, value);
      },
    },
    [],
    checks,
  );
}
