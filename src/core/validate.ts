import type { ComponentNode, JsonValue } from "./types.ts";
import { isComponentNode } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";

interface WalkState {
  readonly seenIds: Set<string>;
  readonly definitions: Set<string>;
  readonly references: { readonly value: string; readonly path: string }[];
  readonly diagnostics: Diagnostic[];
}

function walk(node: ComponentNode, profile: SchemaProfile, path: string, state: WalkState): void {
  const component = profile.components[node.tag];
  if (node.id !== undefined) {
    if (state.seenIds.has(node.id))
      state.diagnostics.push(diag("duplicateId", path, `duplicate id "${node.id}"`));
    else state.seenIds.add(node.id);
  }
  if (component !== undefined) collectReferenceRoles(node, component, path, state);
  for (const [index, item] of (node.content ?? []).entries()) {
    if (isComponentNode(item)) walk(item, profile, `${path}/${item.tag}[${index}]`, state);
  }
}

function collectReferenceRoles(
  node: ComponentNode,
  component: SchemaProfile["components"][string],
  path: string,
  state: WalkState,
): void {
  for (const [name, schema] of Object.entries(component.properties)) {
    const value: JsonValue | undefined = node.props[name];
    if (typeof value === "string") {
      if (schema.referenceRole === "definition") state.definitions.add(value);
      if (schema.referenceRole === "reference")
        state.references.push({ value, path: `${path}.${name}` });
    }
    if (
      schema.type === "array" &&
      schema.minItems !== undefined &&
      Array.isArray(value) &&
      value.length < schema.minItems
    ) {
      state.diagnostics.push(
        diag("invalidValue", `${path}.${name}`, `array has fewer than ${schema.minItems} items`),
      );
    }
  }
}

/**
 * Full structural/invariant validation of a document (SPEC 2/4.4/13):
 * duplicate stable IDs and dangling internal references.
 */
export function validateDocument(root: ComponentNode, profile: SchemaProfile): Diagnostic[] {
  const state: WalkState = {
    seenIds: new Set(),
    definitions: new Set(),
    references: [],
    diagnostics: [],
  };
  walk(root, profile, "$", state);
  for (const reference of state.references) {
    if (!state.definitions.has(reference.value)) {
      state.diagnostics.push(
        diag(
          "danglingReference",
          reference.path,
          `reference "${reference.value}" has no matching definition`,
        ),
      );
    }
  }
  return state.diagnostics;
}
