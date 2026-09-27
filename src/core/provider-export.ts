import type { JsonObject, JsonValue } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import type { Budget, ProviderId } from "./provider-profiles.ts";
import { PROVIDER_PROFILES } from "./provider-profiles.ts";
import type { EmitContext, Measured } from "./provider-schema.ts";
import { emitSchema, measureSchema, newContext } from "./provider-schema.ts";

/**
 * A provider request schema plus an honest account of it: which assertions
 * the provider enforces while generating, which are checked only locally
 * after decode, what could not be expressed, and the measured size of the
 * schema actually emitted against the profile's budgets.
 */
export interface ProviderExport {
  /** `componentProperties`: one component's props only. `document`: a complete document. */
  readonly scope: "componentProperties" | "document";
  readonly route: "properties" | "nativeTree" | "rowProjection";
  readonly provider: ProviderId;
  readonly profileRetrieved: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly tag?: string;
  readonly requestSchema: JsonObject;
  readonly generationEnforced: readonly string[];
  readonly localOnly: readonly string[];
  readonly incompatibilities: readonly string[];
  readonly measured: Measured;
  readonly budgets: {
    readonly maxDepth: Budget;
    readonly maxProperties: Budget;
    readonly maxVariants: Budget;
  };
}

function finish(
  ctx: EmitContext,
  base: Omit<
    ProviderExport,
    | "generationEnforced"
    | "localOnly"
    | "incompatibilities"
    | "measured"
    | "budgets"
    | "profileRetrieved"
  >,
  localOnly: readonly string[],
): ProviderExport {
  const measured = measureSchema(base.requestSchema);
  const incompatibilities = [...ctx.incompatibilities];
  const { maxDepth, maxProperties, maxVariants } = ctx.profile;
  if (measured.depth > maxDepth.value)
    incompatibilities.push(
      `nesting depth ${measured.depth} exceeds the ${maxDepth.basis} budget ${maxDepth.value}`,
    );
  if (measured.properties > maxProperties.value)
    incompatibilities.push(
      `${measured.properties} properties exceed the ${maxProperties.basis} budget ${maxProperties.value}`,
    );
  if (measured.variants > maxVariants.value)
    incompatibilities.push(
      `${measured.variants} variants exceed the ${maxVariants.basis} budget ${maxVariants.value}`,
    );
  return {
    ...base,
    profileRetrieved: ctx.profile.retrieved,
    generationEnforced: [...new Set(ctx.enforced)],
    localOnly: [...new Set([...ctx.localOnly, ...localOnly])],
    incompatibilities,
    measured,
    budgets: { maxDepth, maxProperties, maxVariants },
  };
}

function withDefs(
  schema: JsonObject,
  ctx: EmitContext,
  extra: Record<string, JsonObject> = {},
): JsonObject {
  const defs = { ...ctx.defs, ...extra };
  return Object.keys(defs).length === 0 ? schema : { ...schema, $defs: defs };
}

/** Export one component's properties (not a document; nested components are not part of it). */
export function exportComponentProperties(
  profile: SchemaProfile,
  tag: string,
  provider: ProviderId,
): ProviderExport {
  const ctx = newContext(PROVIDER_PROFILES[provider], profile.definitions);
  const props = profile.standardProps[tag];
  if (props === undefined) throw new Error(`unknown component <${tag}>`);
  const emitted = emitSchema(props, tag, ctx);
  const base = {
    scope: "componentProperties" as const,
    route: "properties" as const,
    provider,
    schemaId: profile.id,
    schemaVersion: profile.version,
    tag,
    requestSchema: withDefs(emitted, ctx),
  };
  return finish(ctx, base, []);
}

function allowedChildren(profile: SchemaProfile, tag: string): readonly string[] {
  return profile.components[tag]?.content.allowedTags ?? Object.keys(profile.components);
}

function union(branches: readonly JsonObject[]): JsonObject {
  return branches.length === 1 ? (branches[0] as JsonObject) : { anyOf: branches };
}

function closed(properties: Record<string, JsonValue>): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function nodeSchema(profile: SchemaProfile, tag: string, ctx: EmitContext): JsonObject {
  const component = profile.components[tag];
  const properties: Record<string, JsonValue> = { tag: { enum: [tag] } };
  if (component?.identity === "stable") properties["id"] = { type: "string" };
  properties["props"] = emitSchema(profile.standardProps[tag] ?? {}, `${tag}.props`, ctx);
  if (component?.content.mode !== "none") {
    const branches: JsonObject[] = allowedChildren(profile, tag).map((child) => ({
      $ref: `#/$defs/node_${child}`,
    }));
    if (component?.content.mode === "mixed") branches.unshift({ type: "string" });
    properties["content"] = { type: "array", items: union(branches) };
  }
  return closed(properties);
}

function tagGraphIsRecursive(profile: SchemaProfile): boolean {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (tag: string): boolean => {
    if (visiting.has(tag)) return true;
    if (done.has(tag)) return false;
    visiting.add(tag);
    const found =
      profile.components[tag]?.content.mode !== "none" && allowedChildren(profile, tag).some(visit);
    visiting.delete(tag);
    done.add(tag);
    return found;
  };
  return visit(profile.rootTag);
}

function nativeTree(profile: SchemaProfile, ctx: EmitContext): JsonObject {
  const nodes: Record<string, JsonObject> = {};
  for (const tag of Object.keys(profile.components))
    nodes[`node_${tag}`] = nodeSchema(profile, tag, ctx);
  if (tagGraphIsRecursive(profile) && !ctx.profile.recursion)
    ctx.incompatibilities.push(
      `the component nesting is recursive, which ${ctx.profile.id} does not support natively`,
    );
  return withDefs(closed({ root: { $ref: `#/$defs/node_${profile.rootTag}` } }), ctx, nodes);
}

function rowSchema(
  profile: SchemaProfile,
  tag: string,
  root: boolean,
  ctx: EmitContext,
): JsonObject {
  const properties: Record<string, JsonValue> = { ref: { type: "string" } };
  if (!root) properties["parent"] = { type: "string" };
  properties["tag"] = { enum: [tag] };
  if (profile.components[tag]?.identity === "stable") properties["id"] = { type: "string" };
  properties["props"] = emitSchema(profile.standardProps[tag] ?? {}, `${tag}.props`, ctx);
  return closed(properties);
}

function rowProjection(profile: SchemaProfile, ctx: EmitContext): JsonObject {
  const rows = Object.keys(profile.components).map((tag) => rowSchema(profile, tag, false, ctx));
  if (Object.values(profile.components).some((c) => c.content.mode === "mixed"))
    rows.push(
      closed({ ref: { type: "string" }, parent: { type: "string" }, text: { type: "string" } }),
    );
  const schema = closed({
    root: rowSchema(profile, profile.rootTag, true, ctx),
    rows: { type: "array", items: union(rows) },
  });
  return withDefs(schema, ctx);
}

/**
 * Export a complete document. `nativeTree` uses recursive definitions (one
 * typed node kind per component, content restricted to allowed children);
 * `rowProjection` is a typed, nonrecursive flat list (order = array order,
 * `ref`/`parent` are transport-only wire references, `id` is the persistent id,
 * text rows carry mixed text). By default the native tree is used when the
 * provider supports recursion and the emitted schema fits the profile's
 * budgets; otherwise the projection. An explicit route is honoured and
 * reports its incompatibilities.
 */
export function exportDocument(
  profile: SchemaProfile,
  provider: ProviderId,
  route?: "nativeTree" | "rowProjection",
): ProviderExport {
  if (route !== undefined) return exportRoute(profile, provider, route);
  const native = PROVIDER_PROFILES[provider].recursion
    ? exportRoute(profile, provider, "nativeTree")
    : undefined;
  // Prefer the native tree only when it fits the profile; otherwise the typed projection.
  return native !== undefined && native.incompatibilities.length === 0
    ? native
    : exportRoute(profile, provider, "rowProjection");
}

function exportRoute(
  profile: SchemaProfile,
  provider: ProviderId,
  route: "nativeTree" | "rowProjection",
): ProviderExport {
  const ctx = newContext(PROVIDER_PROFILES[provider], profile.definitions);
  const requestSchema =
    route === "nativeTree" ? nativeTree(profile, ctx) : rowProjection(profile, ctx);
  const structural =
    route === "nativeTree"
      ? ["persistent id uniqueness", "domain references"]
      : [
          "persistent id uniqueness",
          "domain references",
          "wire reference existence and acyclicity",
          "allowed nesting and content modes",
        ];
  const base = {
    scope: "document" as const,
    route,
    provider,
    schemaId: profile.id,
    schemaVersion: profile.version,
    requestSchema,
  };
  return finish(ctx, base, structural);
}
