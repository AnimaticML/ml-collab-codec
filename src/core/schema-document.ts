import type { JsonObject } from "./types.ts";
import { type Diagnostic, DiagnosticError, diag } from "./diagnostics.ts";
import type { ComponentSchema, ContentMode, SchemaProfile } from "./schema.ts";
import type { DocumentSchemaDefinition } from "./schema-definition.ts";
import { SchemaCompiler } from "./schema-compile.ts";
import { isJsonData, isRecord } from "./schema-keywords.ts";
import { withDefinitions } from "./schema-standard.ts";

const TAG = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MODES = new Set<ContentMode>(["mixed", "element", "none"]);
const TOP_KEYS = new Set([
  "$schema",
  "id",
  "version",
  "rootTag",
  "unknownComponents",
  "$defs",
  "components",
]);
const COMPONENT_KEYS = new Set(["identity", "content", "props", "regionOwner"]);

function text(value: unknown, path: string, out: Diagnostic[]): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  out.push(diag("invalidSchema", path, "must be a non-empty string of at most 200 characters"));
  return "";
}

function checkManifest(raw: Record<string, unknown>, out: Diagnostic[]): void {
  for (const key of Object.keys(raw))
    if (!TOP_KEYS.has(key))
      out.push(diag("capabilityUnsupported", key, `unknown schema field "${key}"`));
  if (
    raw["$schema"] !== undefined &&
    raw["$schema"] !== "https://json-schema.org/draft/2020-12/schema"
  )
    out.push(diag("capabilityUnsupported", "$schema", "only JSON Schema 2020-12 is supported"));
  const policy = raw["unknownComponents"];
  if (policy !== undefined && policy !== "reject" && policy !== "preserve")
    out.push(diag("invalidSchema", "unknownComponents", 'must be "reject" or "preserve"'));
  if (raw["$defs"] !== undefined && !isRecord(raw["$defs"]))
    out.push(diag("invalidSchema", "$defs", "$defs must be an object"));
  if (!isRecord(raw["components"]))
    out.push(diag("invalidSchema", "components", "components must be an object"));
}

function content(
  raw: unknown,
  path: string,
  tags: ReadonlySet<string>,
  out: Diagnostic[],
): ComponentSchema["content"] {
  const record = isRecord(raw) ? raw : {};
  const mode = record["mode"] as ContentMode;
  if (!MODES.has(mode))
    out.push(diag("invalidSchema", `${path}.mode`, 'mode must be "mixed", "element", or "none"'));
  const allowed = record["allowedTags"];
  if (allowed === undefined) return { mode };
  if (!Array.isArray(allowed) || !allowed.every((t) => typeof t === "string" && tags.has(t))) {
    out.push(
      diag("invalidSchema", `${path}.allowedTags`, "allowedTags must list declared component tags"),
    );
    return { mode };
  }
  return { mode, allowedTags: allowed as string[] };
}

function component(
  tag: string,
  raw: unknown,
  tags: ReadonlySet<string>,
  compiler: SchemaCompiler,
  out: Diagnostic[],
): ComponentSchema {
  const path = `components.${tag}`;
  if (!TAG.test(tag))
    out.push(diag("invalidSchema", path, "component tags must match [A-Za-z][A-Za-z0-9_.:-]*"));
  const record = isRecord(raw) ? raw : {};
  for (const key of Object.keys(record))
    if (!COMPONENT_KEYS.has(key))
      out.push(diag("capabilityUnsupported", `${path}.${key}`, `unknown component field "${key}"`));
  const identity = record["identity"];
  if (identity !== "stable" && identity !== "none")
    out.push(diag("invalidSchema", `${path}.identity`, 'identity must be "stable" or "none"'));
  const props = compiler.compile(record["props"], `${path}.props`, 0);
  if (props.type !== "object" || props.variants === true)
    out.push(
      diag("invalidSchema", `${path}.props`, 'props must be a plain { "type": "object" } schema'),
    );
  const owner = record["regionOwner"];
  if (
    owner !== undefined &&
    (typeof owner !== "string" || props.properties?.[owner]?.type !== "string")
  )
    out.push(
      diag(
        "invalidSchema",
        `${path}.regionOwner`,
        "regionOwner must name a declared string property",
      ),
    );
  return {
    tag,
    identity: identity === "stable" ? "stable" : "none",
    content: content(record["content"], `${path}.content`, tags, out),
    props,
    properties: props.properties ?? {},
    ...(typeof owner === "string" ? { regionOwnerProp: owner } : {}),
  };
}

/**
 * Compile a JSON Schema 2020-12 document-schema manifest. Throws a
 * {@link DiagnosticError} listing every problem: unsupported keywords,
 * malformed references, impossible defaults, invalid metadata, or limits.
 */
export function defineDocumentSchema(definition: DocumentSchemaDefinition): SchemaProfile {
  const out: Diagnostic[] = [];
  if (!isRecord(definition) || !isJsonData(definition))
    throw new DiagnosticError([
      diag("invalidSchema", "$", "a schema definition must be plain JSON data"),
    ]);
  const raw = definition as unknown as Record<string, unknown>;
  checkManifest(raw, out);
  const id = text(raw["id"], "id", out);
  const version = text(raw["version"], "version", out);
  const rootTag = text(raw["rootTag"], "rootTag", out);
  const definitions = (isRecord(raw["$defs"]) ? raw["$defs"] : {}) as JsonObject;
  const rawComponents = isRecord(raw["components"]) ? raw["components"] : {};
  const tags = new Set(Object.keys(rawComponents));
  if (!tags.has(rootTag))
    out.push(diag("invalidSchema", "rootTag", "rootTag must name a declared component"));
  const compiler = new SchemaCompiler(definitions);
  compiler.compileDefinitions();
  const components: Record<string, ComponentSchema> = {};
  const standardProps: Record<string, JsonObject> = {};
  for (const [tag, rawComponent] of Object.entries(rawComponents)) {
    components[tag] = component(tag, rawComponent, tags, compiler, out);
    const props = isRecord(rawComponent) ? rawComponent["props"] : undefined;
    standardProps[tag] = withDefinitions((isRecord(props) ? props : {}) as JsonObject, definitions);
  }
  compiler.checkDefaults(definitions);
  const diagnostics = [...out, ...compiler.diagnostics];
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  const unknownComponents = raw["unknownComponents"] === "preserve" ? "preserve" : "reject";
  return { id, version, rootTag, components, unknownComponents, standardProps, definitions };
}
