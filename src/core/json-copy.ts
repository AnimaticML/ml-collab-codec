import type { ComponentNode, DocumentModel, JsonValue } from "./types.ts";
import { type Diagnostic, DiagnosticError, diag } from "./diagnostics.ts";

/** Bounds applied to every JSON value the library acquires. */
const VALUE_LIMITS = { maxDepth: 64 } as const;

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/** Traversal state shared by copying and normalization. */
export interface Walk {
  readonly diagnostics: Diagnostic[];
  readonly ancestors: Set<object>;
}

export function newWalk(): Walk {
  return { diagnostics: [], ancestors: new Set() };
}

/** Enter a container: bounded depth, no reference cycles. */
export function enter(value: object, path: string, depth: number, walk: Walk): boolean {
  if (depth > VALUE_LIMITS.maxDepth) {
    walk.diagnostics.push(diag("limitExceeded", path, "value nesting exceeds the supported depth"));
    return false;
  }
  if (walk.ancestors.has(value)) {
    walk.diagnostics.push(diag("cycleDetected", path, "value contains a reference cycle"));
    return false;
  }
  return true;
}

/** Deep copy of arbitrary JSON data, rejecting non-JSON values, unsafe keys, cycles, and excess depth. */
export function copyJson(
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    walk.diagnostics.push(diag("invalidValue", path, "numbers must be finite"));
    return undefined;
  }
  if (typeof value !== "object") {
    walk.diagnostics.push(diag("invalidValue", path, "not JSON data"));
    return undefined;
  }
  if (!enter(value, path, depth, walk)) return undefined;
  walk.ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value))
    result = value.map((item, i) => copyJson(item, `${path}[${i}]`, depth + 1, walk) ?? null);
  else {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) {
        walk.diagnostics.push(diag("unsafeKey", `${path}.${key}`, `key "${key}" is not allowed`));
        continue;
      }
      const copied = copyJson(item, `${path}.${key}`, depth + 1, walk);
      if (copied !== undefined) out[key] = copied;
    }
    result = out;
  }
  walk.ancestors.delete(value);
  return result;
}

/** Deep copy that throws a {@link DiagnosticError} for anything that is not safe JSON data. */
export function copyJsonStrict(value: unknown, path = "$"): JsonValue {
  const walk = newWalk();
  const copied = copyJson(value, path, 0, walk);
  if (walk.diagnostics.length > 0 || copied === undefined)
    throw new DiagnosticError(walk.diagnostics);
  return copied;
}

/** Deeply mutable JSON, for an application's own working copies. */
export type MutableJsonValue =
  string | number | boolean | null | MutableJsonValue[] | { [key: string]: MutableJsonValue };

export interface EditableNode {
  id?: string;
  tag: string;
  props: { [key: string]: MutableJsonValue };
  content: (string | EditableNode)[];
}

export interface EditableDocument {
  readonly schemaId: string;
  readonly schemaVersion: string;
  root: EditableNode;
}

function editableNode(node: ComponentNode): EditableNode {
  const out: EditableNode = {
    tag: node.tag,
    props: copyJsonStrict(node.props) as { [key: string]: MutableJsonValue },
    content: (node.content ?? []).map((item) =>
      typeof item === "string" ? item : editableNode(item),
    ),
  };
  if (node.id !== undefined) out.id = node.id;
  return out;
}

/**
 * A deep, independent, mutable copy of a document for free edits (for
 * example an agent producing B from A). Editing it never affects the model,
 * the table, or any snapshot it came from.
 */
export function editableCopy(model: DocumentModel): EditableDocument {
  return {
    schemaId: model.schemaId,
    schemaVersion: model.schemaVersion,
    root: editableNode(model.root),
  };
}
