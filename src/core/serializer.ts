import type { ComponentNode, ContentItem, DocumentModel, JsonValue } from "./types.ts";
import { isComponentNode } from "./types.ts";
import type { ComponentSchema, PropertySchema, SchemaProfile } from "./schema.ts";
import { deepEqual } from "./normalize.ts";
import { propertyToAttributeName } from "./naming.ts";

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeJsonForScript(json: string): string {
  return json.replace(/<\//g, "<\\/");
}

function isCommaSafe(
  schema: PropertySchema,
  value: JsonValue,
): value is (string | number | boolean)[] {
  if (
    schema.type !== "array" ||
    !schema.commaShorthand ||
    !Array.isArray(value) ||
    value.length === 0
  )
    return false;
  return value.every((member) => {
    if (typeof member === "object" || member === null) return false;
    const text = String(member);
    return (
      typeof member !== "string" || (!text.includes(",") && text === text.trim() && text.length > 0)
    );
  });
}

interface AttributeEncoding {
  readonly attributes: string[];
  readonly jsonProps: Record<string, JsonValue>;
}

function encodeProp(
  name: string,
  schema: PropertySchema,
  value: JsonValue,
): { attr: string | null; json: boolean } {
  if (schema.type === "object") return { attr: null, json: true };
  const attrName = propertyToAttributeName(name);
  if (attrName === null) return { attr: null, json: true };
  if (schema.type === "array") {
    if (!isCommaSafe(schema, value)) return { attr: null, json: true };
    return { attr: `${attrName}="${escapeAttribute(value.join(","))}"`, json: false };
  }
  const scalar: string | number | boolean = typeof value === "object" ? "" : value;
  return { attr: `${attrName}="${escapeAttribute(String(scalar))}"`, json: false };
}

function encodeProps(
  component: ComponentSchema,
  props: Readonly<Record<string, JsonValue>>,
): AttributeEncoding {
  const attributes: string[] = [];
  const jsonProps: Record<string, JsonValue> = {};
  for (const [name, schema] of Object.entries(component.properties)) {
    const value = props[name];
    if (value === undefined) continue;
    if (schema.default !== undefined && deepEqual(value, schema.default)) continue;
    const encoded = encodeProp(name, schema, value);
    if (encoded.json) jsonProps[name] = value;
    else if (encoded.attr !== null) attributes.push(encoded.attr);
  }
  return { attributes, jsonProps };
}

function serializeContent(items: readonly ContentItem[], profile: SchemaProfile): string {
  return items
    .map((item) => (typeof item === "string" ? escapeText(item) : serializeNode(item, profile)))
    .join("");
}

function serializeNode(node: ComponentNode, profile: SchemaProfile): string {
  const component = profile.components[node.tag];
  if (component === undefined) return serializeOpaqueNode(node, profile);
  const { attributes, jsonProps } = encodeProps(component, node.props);
  const attrParts =
    node.id === undefined ? attributes : [`id="${escapeAttribute(node.id)}"`, ...attributes];
  const hasJson = Object.keys(jsonProps).length > 0;
  const content = node.content ?? [];
  if (!hasJson && content.length === 0) {
    return `<${node.tag}${attrParts.length > 0 ? " " + attrParts.join(" ") : ""} />`;
  }
  const jsonBlock = hasJson
    ? `<script type="application/json">${escapeJsonForScript(JSON.stringify(jsonProps))}</script>`
    : "";
  const body = jsonBlock + serializeContent(content, profile);
  return `<${node.tag}${attrParts.length > 0 ? " " + attrParts.join(" ") : ""}>${body}</${node.tag}>`;
}

function serializeOpaqueNode(node: ComponentNode, profile: SchemaProfile): string {
  const attrParts: string[] = [];
  if (node.id !== undefined) attrParts.push(`id="${escapeAttribute(node.id)}"`);
  for (const [key, value] of Object.entries(node.props)) {
    if (typeof value === "string") attrParts.push(`${key}="${escapeAttribute(value)}"`);
  }
  const content = node.content ?? [];
  if (content.length === 0)
    return `<${node.tag}${attrParts.length > 0 ? " " + attrParts.join(" ") : ""} />`;
  const body = content
    .map((item) =>
      typeof item === "string"
        ? escapeText(item)
        : isComponentNode(item)
          ? serializeNode(item, profile)
          : "",
    )
    .join("");
  return `<${node.tag}${attrParts.length > 0 ? " " + attrParts.join(" ") : ""}>${body}</${node.tag}>`;
}

export function serializeDocument(model: DocumentModel, profile: SchemaProfile): string {
  return serializeNode(model.root, profile);
}

export function serializeFragment(items: readonly ContentItem[], profile: SchemaProfile): string {
  return serializeContent(items, profile);
}
