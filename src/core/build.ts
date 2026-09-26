import type { ComponentNode, ContentItem, JsonValue } from "./types.ts";
import type { ComponentSchema, PropertySchema, SchemaProfile } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { attributePathToPropertyPath } from "./naming.ts";
import { PropsBuilder } from "./merge.ts";
import { normalizeComponentProps } from "./normalize.ts";
import type { RawAttribute, RawElement, RawJsonBlock, RawNode } from "./tokenizer.ts";

interface BuildContext {
  readonly profile: SchemaProfile;
  readonly seenIds: Set<string>;
  readonly diagnostics: Diagnostic[];
}

function resolvePropertySchema(
  properties: Readonly<Record<string, PropertySchema>>,
  segments: readonly string[],
): PropertySchema | undefined {
  const [head, ...rest] = segments;
  if (head === undefined) return undefined;
  const property = properties[head];
  if (property === undefined) return undefined;
  if (rest.length === 0) return property;
  if (property.type === "object" && property.properties)
    return resolvePropertySchema(property.properties, rest);
  return undefined;
}

const NUMBER_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function coerceAttributeValue(schema: PropertySchema | undefined, raw: string): JsonValue {
  if (schema === undefined) return raw;
  if (schema.type === "number") return NUMBER_LITERAL.test(raw) ? Number(raw) : raw;
  if (schema.type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  if (schema.type === "array" && schema.commaShorthand) {
    const members = raw.length === 0 ? [] : raw.split(",");
    return members.map((member) => coerceAttributeValue(schema.items, member));
  }
  return raw;
}

function applyAttribute(
  builder: PropsBuilder,
  attribute: RawAttribute,
  component: ComponentSchema | undefined,
  path: string,
): { id: string | null } {
  const segments = attributePathToPropertyPath(attribute.rawName);
  if (segments.length === 1 && segments[0] === "id") return { id: attribute.value };
  const propertySchema = component
    ? resolvePropertySchema(component.properties, segments)
    : undefined;
  const value = coerceAttributeValue(propertySchema, attribute.value);
  builder.setAttributePath(segments, value, path);
  return { id: null };
}

function applyJsonBlock(
  builder: PropsBuilder,
  block: RawJsonBlock,
  path: string,
  diagnostics: Diagnostic[],
): void {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(block.raw) as JsonValue;
  } catch {
    diagnostics.push(diag("malformedJson", path, "JSON block failed to parse"));
    return;
  }
  const target = block.target === null ? null : attributePathToPropertyPath(block.target);
  builder.mergeJsonBlock(target, parsed, path);
}

function checkContentMode(
  component: ComponentSchema,
  items: readonly ContentItem[],
  path: string,
  diagnostics: Diagnostic[],
): ContentItem[] {
  const mode = component.content.mode;
  if (mode === "none") {
    if (items.some((item) => typeof item !== "string" || item.trim().length > 0)) {
      diagnostics.push(diag("invalidNesting", path, `<${component.tag}> does not accept content`));
    }
    return [];
  }
  const filtered = items.filter((item) => {
    if (typeof item !== "string") return true;
    if (mode === "element" && item.trim().length === 0) return false;
    if (mode === "element" && item.trim().length > 0) {
      diagnostics.push(
        diag("invalidNesting", path, `<${component.tag}> is element-only; unexpected text`),
      );
      return false;
    }
    return true;
  });
  for (const item of filtered) {
    if (typeof item === "string") continue;
    const allowed = component.content.allowedTags;
    if (allowed && !allowed.includes(item.tag)) {
      diagnostics.push(
        diag("invalidNesting", path, `<${item.tag}> is not allowed inside <${component.tag}>`),
      );
    }
  }
  return filtered;
}

function buildOpaqueNode(element: RawElement, context: BuildContext, path: string): ComponentNode {
  const props: Record<string, JsonValue> = {};
  let id: string | undefined;
  for (const attribute of element.attributes) {
    if (attribute.rawName === "id") id = attribute.value;
    else props[attribute.rawName] = attribute.value;
  }
  const content = element.children
    .filter(
      (child): child is RawElement | string =>
        typeof child === "string" || child.kind === "element",
    )
    .map((child) =>
      typeof child === "string" ? child : buildNode(child, context, `${path}/${child.tag}`),
    );
  return id === undefined
    ? { tag: element.tag, props, content }
    : { id, tag: element.tag, props, content };
}

function buildNode(element: RawElement, context: BuildContext, path: string): ComponentNode {
  const component = context.profile.components[element.tag];
  if (component === undefined) {
    if (context.profile.unknownPolicy === "opaque") return buildOpaqueNode(element, context, path);
    context.diagnostics.push(diag("unknownTag", path, `unknown component <${element.tag}>`));
    return { tag: element.tag, props: {} };
  }
  const builder = new PropsBuilder();
  let id: string | undefined;
  for (const attribute of element.attributes) {
    const result = applyAttribute(builder, attribute, component, path);
    if (result.id !== null) id = result.id;
  }
  for (const child of element.children) {
    if (typeof child !== "string" && child.kind === "json")
      applyJsonBlock(builder, child, path, context.diagnostics);
  }
  context.diagnostics.push(...builder.diagnostics);
  const normalized = normalizeComponentProps(component, builder.build(), path);
  context.diagnostics.push(...normalized.diagnostics);

  if (component.identity === "stable") {
    if (id === undefined)
      context.diagnostics.push(
        diag("missingRequired", `${path}.id`, "stable component requires an id"),
      );
    else if (context.seenIds.has(id))
      context.diagnostics.push(diag("duplicateId", `${path}.id`, `duplicate id "${id}"`));
    else context.seenIds.add(id);
  }

  const contentItems = element.children
    .filter(
      (child): child is RawElement | string =>
        typeof child === "string" || child.kind === "element",
    )
    .map((child) =>
      typeof child === "string" ? child : buildNode(child, context, `${path}/${child.tag}`),
    );
  const content = checkContentMode(component, contentItems, path, context.diagnostics);

  const node: ComponentNode = { tag: element.tag, props: normalized.value, content };
  return id === undefined ? node : { ...node, id };
}

export function buildFragment(
  nodes: readonly RawNode[],
  profile: SchemaProfile,
  path: string,
): { items: ContentItem[]; diagnostics: Diagnostic[] } {
  const context: BuildContext = { profile, seenIds: new Set(), diagnostics: [] };
  const items: ContentItem[] = [];
  for (const node of nodes) {
    if (typeof node === "string") items.push(node);
    else if (node.kind === "element") items.push(buildNode(node, context, `${path}/${node.tag}`));
    else context.diagnostics.push(diag("invalidNesting", path, "unexpected top-level JSON block"));
  }
  return { items, diagnostics: context.diagnostics };
}
