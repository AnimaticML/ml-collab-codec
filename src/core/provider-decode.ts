import type { ComponentNode, DocumentModel, JsonObject, JsonValue } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import { type Diagnostic, type Result, diag, err, ok } from "./diagnostics.ts";
import { normalizeComponentProps } from "./normalize.ts";
import { validateDocument } from "./validate.ts";

/** Decode provider-emitted structured output for one component (SPEC 12.1/S03/S07): reuses the same effective-value rules as the codec, never a presence wrapper. */
export function decodeComponentOutput(
  tag: string,
  raw: JsonObject,
  profile: SchemaProfile,
  path: string,
): Result<ComponentNode> {
  const component = profile.components[tag];
  if (component === undefined) return err([diag("unknownTag", path, `unknown component <${tag}>`)]);
  const normalized = normalizeComponentProps(component, raw, path);
  if (normalized.diagnostics.length > 0) return err(normalized.diagnostics);
  return ok({ tag, props: normalized.value });
}

interface WireNode {
  readonly wireRef: string;
  readonly id: string | null;
  readonly tag: string;
  readonly props: JsonObject;
  readonly parentWireRef: string | null;
  readonly orderKey: string;
}

function isWireNode(value: JsonValue): value is JsonObject & WireNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value["wireRef"] === "string"
  );
}

/**
 * Decode a node-table projection response (SPEC 12.2/S04/S06/S07): full
 * local structural validation runs before any transaction may touch the
 * document. Wire references are transport-only; only rows with a non-null
 * `id` surface as persisted stable IDs.
 */
export function decodeNodeTable(
  nodes: readonly JsonValue[],
  profile: SchemaProfile,
): Result<DocumentModel> {
  const diagnostics: Diagnostic[] = [];
  const byWireRef = new Map<string, WireNode>();
  for (const [index, raw] of nodes.entries()) {
    if (!isWireNode(raw)) {
      diagnostics.push(diag("invalidValue", `$.nodes[${index}]`, "malformed node-table row"));
      continue;
    }
    if (byWireRef.has(raw.wireRef))
      diagnostics.push(
        diag("duplicateId", `$.nodes[${index}]`, `duplicate wireRef ${raw.wireRef}`),
      );
    byWireRef.set(raw.wireRef, raw);
  }
  if (diagnostics.length > 0) return err(diagnostics);

  const roots = [...byWireRef.values()].filter((n) => n.parentWireRef === null);
  if (roots.length !== 1 || roots[0]?.tag !== profile.rootTag) {
    return err([diag("invalidNesting", "$", "expected exactly one root of the schema's root tag")]);
  }
  for (const node of byWireRef.values()) {
    if (node.parentWireRef !== null && !byWireRef.has(node.parentWireRef)) {
      diagnostics.push(
        diag("danglingReference", `$.nodes`, `dangling parentWireRef ${node.parentWireRef}`),
      );
    }
  }
  if (diagnostics.length > 0) return err(diagnostics);
  if (hasCycle(byWireRef))
    return err([diag("cycleDetected", "$", "node table contains a parent cycle")]);

  const rootNode = roots[0];
  if (rootNode === undefined)
    return err([diag("invalidNesting", "$", "expected exactly one root")]);
  const root = buildFromWire(rootNode, byWireRef, diagnostics);
  if (diagnostics.length > 0) return err(diagnostics);
  const model: DocumentModel = { schemaId: profile.id, schemaVersion: profile.version, root };
  const structuralIssues = validateDocument(root, profile);
  if (structuralIssues.length > 0) return err(structuralIssues);
  return ok(model);
}

function hasCycle(byWireRef: ReadonlyMap<string, WireNode>): boolean {
  for (const start of byWireRef.keys()) {
    const seen = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byWireRef.get(cursor)?.parentWireRef ?? null;
    }
  }
  return false;
}

function buildFromWire(
  node: WireNode,
  byWireRef: ReadonlyMap<string, WireNode>,
  diagnostics: Diagnostic[],
): ComponentNode {
  const children = [...byWireRef.values()]
    .filter((n) => n.parentWireRef === node.wireRef)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1))
    .map((child) =>
      child.tag === "#text"
        ? textValue(child, diagnostics)
        : buildFromWire(child, byWireRef, diagnostics),
    );
  const base: ComponentNode = { tag: node.tag, props: node.props, content: children };
  return node.id === null ? base : { ...base, id: node.id };
}

function textValue(node: WireNode, diagnostics: Diagnostic[]): string {
  const value = node.props["value"];
  if (typeof value === "string") return value;
  diagnostics.push(
    diag("invalidValue", `$.nodes[${node.wireRef}]`, "#text row missing string value"),
  );
  return "";
}

/** Simulated SDK/provider transport outcomes (SPEC 12.3/S08): only "ok" can ever become an applicable document. */
export type ProviderResponse =
  | { readonly status: "ok"; readonly json: string }
  | { readonly status: "refusal"; readonly reason: string }
  | { readonly status: "incomplete"; readonly partialJson: string }
  | { readonly status: "schemaError"; readonly detail: string };

export function decodeProviderResponse(
  response: ProviderResponse,
  tag: string,
  profile: SchemaProfile,
): Result<ComponentNode> {
  if (response.status !== "ok") {
    return err([
      diag("invalidValue", "$", `provider response was not applicable: ${response.status}`),
    ]);
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(response.json) as JsonValue;
  } catch {
    return err([diag("malformedJson", "$", "provider JSON failed to parse")]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err([diag("invalidValue", "$", "provider output must be an object")]);
  }
  return decodeComponentOutput(tag, parsed, profile, "$");
}
