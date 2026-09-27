import type { ComponentNode, ContentItem, DocumentModel, JsonValue } from "./types.ts";
import type { ComponentSchema, PropertySchema, SchemaProfile } from "./schema.ts";
import { type Diagnostic, type Result, diag, duplicateDefinition, err, ok } from "./diagnostics.ts";
import { normalizeComponentProps } from "./normalize.ts";

/** Resource bounds for documents accepted from any entry path. */
export const DOCUMENT_LIMITS = { maxDepth: 256, maxNodes: 1_000_000, maxIdLength: 256 } as const;

interface State {
  readonly profile: SchemaProfile;
  readonly diagnostics: Diagnostic[];
  readonly ids: Set<string>;
  readonly definitions: Set<string>;
  readonly references: { value: string; path: string }[];
  readonly ancestors: Set<object>;
  nodes: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect domain definition/reference values anywhere inside normalized props. */
function collectRoles(
  schema: PropertySchema | undefined,
  value: JsonValue | undefined,
  path: string,
  state: State,
): void {
  if (schema === undefined || value === undefined || schema.variants === true) return;
  if (typeof value === "string" && schema.reference === "definition") {
    if (state.definitions.has(value)) state.diagnostics.push(duplicateDefinition(value, path));
    state.definitions.add(value);
  }
  if (typeof value === "string" && schema.reference === "reference")
    state.references.push({ value, path });
  if (Array.isArray(value))
    value.forEach((item: JsonValue, i) => collectRoles(schema.items, item, `${path}[${i}]`, state));
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      const declared =
        schema.properties !== undefined && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      const extra = schema.additional?.kind === "schema" ? schema.additional.schema : undefined;
      collectRoles(declared ?? extra, item, `${path}.${key}`, state);
    }
}

function checkId(
  node: Readonly<Record<string, unknown>>,
  component: ComponentSchema | undefined,
  path: string,
  state: State,
): string | undefined {
  const id = node["id"];
  if (id === undefined) {
    if (component?.identity === "stable")
      state.diagnostics.push(
        diag("missingRequired", `${path}.id`, `<${component.tag}> requires an id`),
      );
    return undefined;
  }
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > DOCUMENT_LIMITS.maxIdLength ||
    id === "$root"
  ) {
    state.diagnostics.push(diag("invalidValue", `${path}.id`, "an id must be a non-empty string"));
    return undefined;
  }
  if (state.ids.has(id))
    state.diagnostics.push(diag("duplicateId", `${path}.id`, `duplicate id "${id}"`));
  state.ids.add(id);
  return id;
}

/** Canonical content: adjacent text merged, empty text dropped, mode and nesting rules applied. */
function normalizeContent(
  raw: unknown,
  component: ComponentSchema | undefined,
  path: string,
  depth: number,
  state: State,
): ContentItem[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    state.diagnostics.push(diag("invalidValue", `${path}.content`, "content must be an array"));
    return [];
  }
  const mode = component?.content.mode ?? "mixed";
  const out: ContentItem[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `${path}.content[${index}]`;
    if (typeof item === "string") {
      if (mode !== "mixed" && item.trim().length > 0)
        state.diagnostics.push(
          diag("invalidNesting", at, `<${component?.tag ?? "?"}> does not accept text`),
        );
      if (mode !== "mixed" || item.length === 0) continue;
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = last + item;
      else out.push(item);
      continue;
    }
    if (mode === "none")
      state.diagnostics.push(
        diag("invalidNesting", at, `<${component?.tag ?? "?"}> does not accept content`),
      );
    const child = normalizeNode(item, at, depth + 1, state);
    const allowed = component?.content.allowedTags;
    if (child !== undefined && allowed !== undefined && !allowed.includes(child.tag))
      state.diagnostics.push(
        diag(
          "invalidNesting",
          at,
          `<${child.tag}> is not allowed inside <${component?.tag ?? "?"}>`,
        ),
      );
    if (child !== undefined && mode !== "none") out.push(child);
  }
  return out;
}

function normalizeNode(
  raw: unknown,
  path: string,
  depth: number,
  state: State,
): ComponentNode | undefined {
  state.nodes += 1;
  if (depth > DOCUMENT_LIMITS.maxDepth || state.nodes > DOCUMENT_LIMITS.maxNodes) {
    state.diagnostics.push(
      diag("limitExceeded", path, "document exceeds the supported size or depth"),
    );
    return undefined;
  }
  if (!isRecord(raw) || typeof raw["tag"] !== "string") {
    state.diagnostics.push(
      diag("invalidValue", path, "expected a component node { tag, props, content? }"),
    );
    return undefined;
  }
  if (state.ancestors.has(raw)) {
    state.diagnostics.push(diag("cycleDetected", path, "node contains itself"));
    return undefined;
  }
  state.ancestors.add(raw);
  const tag = raw["tag"];
  const component = Object.hasOwn(state.profile.components, tag)
    ? state.profile.components[tag]
    : undefined;
  if (component === undefined && state.profile.unknownComponents === "reject")
    state.diagnostics.push(diag("unknownTag", path, `unknown component <${tag}>`));
  const id = checkId(raw, component, path, state);
  const props = normalizeComponentProps(state.profile, tag, raw["props"] ?? {}, `${path}.props`);
  state.diagnostics.push(...props.diagnostics);
  collectRoles(component?.props, props.value, `${path}.props`, state);
  const content = normalizeContent(raw["content"], component, path, depth, state);
  state.ancestors.delete(raw);
  return id === undefined
    ? { tag, props: props.value, content }
    : { id, tag, props: props.value, content };
}

/**
 * The one effective-value contract for documents from every entry path
 * (source parse, JSON import, provider decode, proposals, checkpoints, and
 * authority validation): returns a normalized fresh copy and every
 * diagnostic. The input is never mutated.
 */
export function normalizeDocument(
  root: unknown,
  profile: SchemaProfile,
): { root: ComponentNode | undefined; diagnostics: readonly Diagnostic[] } {
  const state: State = {
    profile,
    diagnostics: [],
    ids: new Set(),
    definitions: new Set(),
    references: [],
    ancestors: new Set(),
    nodes: 0,
  };
  const node = normalizeNode(root, "$", 0, state);
  if (node !== undefined && node.tag !== profile.rootTag)
    state.diagnostics.push(diag("invalidValue", "$", `root must be <${profile.rootTag}>`));
  for (const reference of state.references)
    if (!state.definitions.has(reference.value))
      state.diagnostics.push(
        diag(
          "danglingReference",
          reference.path,
          `reference "${reference.value}" has no matching definition`,
        ),
      );
  return { root: node, diagnostics: state.diagnostics };
}

/**
 * Normalize top-level fragment/multi-root items (any declared tags) with one
 * shared id space. Significant top-level text is kept only when `allowText`.
 */
export function normalizeFragment(
  items: readonly unknown[],
  profile: SchemaProfile,
  allowText: boolean,
): { items: ContentItem[]; diagnostics: readonly Diagnostic[] } {
  const state: State = {
    profile,
    diagnostics: [],
    ids: new Set(),
    definitions: new Set(),
    references: [],
    ancestors: new Set(),
    nodes: 0,
  };
  const out: ContentItem[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === "string") {
      if (item.trim().length === 0 && !allowText) continue;
      if (!allowText)
        state.diagnostics.push(
          diag("extraRoot", `$[${index}]`, "top-level text is not allowed here"),
        );
      else out.push(item);
      continue;
    }
    const node = normalizeNode(item, `$[${index}]`, 0, state);
    if (node !== undefined) out.push(node);
  }
  for (const reference of state.references)
    if (!state.definitions.has(reference.value))
      state.diagnostics.push(
        diag(
          "danglingReference",
          reference.path,
          `reference "${reference.value}" has no matching definition`,
        ),
      );
  return { items: out, diagnostics: state.diagnostics };
}

/** Standalone validation: every diagnostic of the effective-value contract; never mutates. */
export function validateDocument(root: ComponentNode, profile: SchemaProfile): Diagnostic[] {
  return [...normalizeDocument(root, profile).diagnostics];
}

/** Import the JSON form `{ schemaId, schemaVersion, root }` through the same contract. */
export function decodeDocumentJson(value: unknown, profile: SchemaProfile): Result<DocumentModel> {
  if (!isRecord(value))
    return err([diag("invalidValue", "$", "expected { schemaId, schemaVersion, root }")]);
  if (value["schemaId"] !== profile.id || value["schemaVersion"] !== profile.version)
    return err([
      diag(
        "invalidValue",
        "$",
        `document declares schema ${String(value["schemaId"])}@${String(value["schemaVersion"])}, expected ${profile.id}@${profile.version}`,
      ),
    ]);
  const result = normalizeDocument(value["root"], profile);
  if (result.root === undefined || result.diagnostics.length > 0) return err(result.diagnostics);
  return ok({ schemaId: profile.id, schemaVersion: profile.version, root: result.root });
}
