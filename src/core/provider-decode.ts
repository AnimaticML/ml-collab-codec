import type { ComponentNode, DocumentModel, JsonObject, JsonValue } from "./types.ts";
import { isJsonObject } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import { type Diagnostic, type Result, diag, err, ok } from "./diagnostics.ts";
import { normalizeComponentProps } from "./normalize.ts";
import { DOCUMENT_LIMITS, normalizeDocument } from "./document-check.ts";
import { standardDiagnostics } from "./schema-standard.ts";
import type { ProviderExport } from "./provider-export.ts";

/** Transport outcomes of a provider call; only `ok` can ever become applicable data. */
export type ProviderResponse =
  | { readonly status: "ok"; readonly json: string }
  | { readonly status: "refusal"; readonly reason: string }
  | { readonly status: "incomplete"; readonly partialJson: string }
  | { readonly status: "schemaError"; readonly detail: string };

const MAX_ROWS = 100_000;

function asNode(
  value: JsonValue,
  path: string,
  out: Diagnostic[],
  depth = 0,
): ComponentNode | undefined {
  if (depth > DOCUMENT_LIMITS.maxDepth) {
    out.push(diag("limitExceeded", path, "node nesting exceeds the supported depth"));
    return undefined;
  }
  if (!isJsonObject(value) || typeof value["tag"] !== "string") {
    out.push(diag("invalidValue", path, "expected a node { tag, props, content }"));
    return undefined;
  }
  const content: (string | ComponentNode)[] = [];
  const raw = value["content"];
  if (Array.isArray(raw))
    raw.forEach((item: JsonValue, i) => {
      if (typeof item === "string") content.push(item);
      else {
        const child = asNode(item, `${path}.content[${i}]`, out, depth + 1);
        if (child !== undefined) content.push(child);
      }
    });
  const props = isJsonObject(value["props"]) ? value["props"] : {};
  const node = { tag: value["tag"], props, content };
  return typeof value["id"] === "string" ? { id: value["id"], ...node } : node;
}

interface Row {
  readonly ref: string;
  readonly parent: string | null;
  readonly node?: ComponentNode;
  readonly text?: string;
}

function readRow(
  value: JsonValue,
  root: boolean,
  path: string,
  out: Diagnostic[],
): Row | undefined {
  if (
    !isJsonObject(value) ||
    typeof value["ref"] !== "string" ||
    (!root && typeof value["parent"] !== "string")
  ) {
    out.push(diag("invalidValue", path, "malformed row: ref and parent are required"));
    return undefined;
  }
  const parent = root ? null : (value["parent"] as string);
  if (typeof value["text"] === "string" && !("tag" in value))
    return { ref: value["ref"], parent, text: value["text"] };
  const node = asNode({ ...value, content: [] }, path, out);
  return node === undefined ? undefined : { ref: value["ref"], parent, node };
}

/** Rebuild a tree from typed rows: unique refs, existing parents, no cycles, order = array order. */
function treeFromRows(value: JsonObject, out: Diagnostic[]): ComponentNode | undefined {
  const rows = Array.isArray(value["rows"]) ? (value["rows"] as readonly JsonValue[]) : [];
  if (rows.length > MAX_ROWS) {
    out.push(diag("limitExceeded", "$.rows", "too many rows"));
    return undefined;
  }
  const root = readRow(value["root"] ?? null, true, "$.root", out);
  const decoded = rows.map((row, i) => readRow(row, false, `$.rows[${i}]`, out));
  if (root?.node === undefined || out.length > 0) return undefined;
  const byRef = new Map<string, Row>([[root.ref, root]]);
  const childrenOf = new Map<string, Row[]>();
  for (const row of decoded as Row[]) {
    if (byRef.has(row.ref))
      out.push(diag("duplicateId", "$.rows", `duplicate wire reference ${row.ref}`));
    byRef.set(row.ref, row);
    childrenOf.set(row.parent ?? "", [...(childrenOf.get(row.parent ?? "") ?? []), row]);
  }
  for (const row of byRef.values())
    if (row.parent !== null && !byRef.has(row.parent))
      out.push(
        diag("danglingReference", "$.rows", `row ${row.ref} has an unknown parent ${row.parent}`),
      );
    else if (row.parent !== null && byRef.get(row.parent)?.node === undefined)
      out.push(diag("invalidNesting", "$.rows", `row ${row.ref} is nested in a text row`));
  if (out.length > 0) return undefined;
  const reached = new Set<string>();
  const build = (row: Row, depth: number): ComponentNode => {
    reached.add(row.ref);
    if (depth > DOCUMENT_LIMITS.maxDepth) {
      out.push(diag("limitExceeded", "$.rows", "row nesting exceeds the supported depth"));
      return { ...(row.node as ComponentNode), content: [] };
    }
    const content = (childrenOf.get(row.ref) ?? []).map((child) => {
      if (child.text === undefined) return build(child, depth + 1);
      reached.add(child.ref);
      return child.text;
    });
    return { ...(row.node as ComponentNode), content };
  };
  const tree = build(root, 0);
  if (reached.size !== byRef.size)
    out.push(
      diag(
        "cycleDetected",
        "$.rows",
        "rows are not all reachable from the root (cycle or detached rows)",
      ),
    );
  return tree;
}

/**
 * Decode a provider result against the export it was requested with: first
 * the emitted request schema, then the complete local effective-value and
 * structural contract (the same one every entry path uses). A wire
 * reference is never trusted as proof of a well-typed row.
 */
export function decodeProviderOutput(
  exported: ProviderExport,
  value: unknown,
  profile: SchemaProfile,
): Result<DocumentModel | JsonObject> {
  if (exported.schemaId !== profile.id || exported.schemaVersion !== profile.version)
    return err([diag("invalidValue", "$", "the export was made for a different schema version")]);
  if (!isJsonObject(value as JsonValue))
    return err([diag("invalidValue", "$", "provider output must be an object")]);
  const shape = standardDiagnostics(exported.requestSchema, value as JsonValue, "$");
  if (shape.length > 0) return err(shape);
  const object = value as JsonObject;
  if (exported.scope === "componentProperties") {
    const props = normalizeComponentProps(profile, exported.tag ?? "", object, "$");
    return props.diagnostics.length > 0 ? err(props.diagnostics) : ok(props.value);
  }
  const out: Diagnostic[] = [];
  const tree =
    exported.route === "rowProjection"
      ? treeFromRows(object, out)
      : asNode(object["root"] ?? null, "$.root", out);
  if (tree === undefined || out.length > 0) return err(out);
  const normalized = normalizeDocument(tree, profile);
  if (normalized.root === undefined || normalized.diagnostics.length > 0)
    return err(normalized.diagnostics);
  return ok({ schemaId: profile.id, schemaVersion: profile.version, root: normalized.root });
}

/** Only an `ok` transport result with parseable JSON reaches decoding. */
export function decodeProviderResponse(
  response: ProviderResponse,
  exported: ProviderExport,
  profile: SchemaProfile,
): Result<DocumentModel | JsonObject> {
  if (response.status !== "ok")
    return err([
      diag("invalidValue", "$", `provider response was not applicable: ${response.status}`),
    ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.json);
  } catch {
    return err([diag("malformedJson", "$", "provider JSON failed to parse")]);
  }
  return decodeProviderOutput(exported, parsed, profile);
}
