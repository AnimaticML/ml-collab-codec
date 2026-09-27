import type { ComponentNode, ContentItem, DocumentModel, JsonObject, JsonValue } from "./types.ts";
import { copyJsonStrict } from "./json-copy.ts";
import type { PropertySchema, SchemaProfile } from "./schema.ts";
import { getComponentSchema, propertyAtPath } from "./schema.ts";
import { deepEqual } from "./normalize.ts";
import { propertyToAttributeName } from "./naming.ts";

/**
 * Canonical, lossless printing: every accepted effective datum survives
 * `parse(print(model))`, including preserved (opaque) properties of known
 * components and structured values of unknown opaque components. A value is
 * written as an attribute only when the parser provably decodes that
 * attribute back to the same property and value; everything else goes into
 * the component's JSON block. A value JSON cannot represent (a non-finite
 * number, an unsafe key, a cycle) throws a `DiagnosticError`: nothing is
 * printed rather than printing something different.
 */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `</` cannot appear inside the script element that carries JSON. */
function escapeJsonForScript(json: string): string {
  return json.replace(/<\//g, "<\\/");
}

const ATTRIBUTE_NAME = /^-?[a-z][a-z0-9-]*$/;

function attributeName(property: string): string | null {
  if (property === "id" || property.includes(".")) return null;
  const name = propertyToAttributeName(property);
  return name !== null && ATTRIBUTE_NAME.test(name) ? name : null;
}

function commaText(schema: PropertySchema, value: readonly JsonValue[]): string | null {
  if (value.length === 0) return null;
  const parts: string[] = [];
  for (const member of value) {
    if (typeof member === "string") {
      if (member.includes(",") || member !== member.trim() || member.length === 0) return null;
      if (schema.items?.type !== "string") return null;
    } else if (typeof member !== "number" && typeof member !== "boolean") return null;
    parts.push(String(member));
  }
  return parts.join(",");
}

/** Attribute text that decodes to exactly `value` under `schema`, or null. */
function attributeText(schema: PropertySchema | undefined, value: JsonValue): string | null {
  if (schema === undefined) return typeof value === "string" ? value : null;
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? value : null;
    case "number":
    case "integer":
    case "boolean":
      return typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    case "array":
      return schema.commaShorthand === true && Array.isArray(value)
        ? commaText(schema, value)
        : null;
    default:
      return null;
  }
}

function encodeProps(
  node: ComponentNode,
  profile: SchemaProfile,
): { attributes: string[]; json: Record<string, JsonValue> } {
  const root = getComponentSchema(profile, node.tag)?.props;
  const attributes: string[] = [];
  const json: Record<string, JsonValue> = {};
  // Refuse (DiagnosticError) what JSON cannot carry, e.g. NaN, instead of printing it as null.
  const props = copyJsonStrict(node.props, `<${node.tag}>`) as JsonObject;
  for (const [name, value] of Object.entries(props)) {
    // The same lookup the parser uses to decode an attribute of this name.
    const schema = propertyAtPath(root, [name]);
    if (schema?.default !== undefined && deepEqual(value, schema.default)) continue;
    const attr = attributeName(name);
    const text = attr === null ? null : attributeText(schema, value);
    if (attr !== null && text !== null) attributes.push(`${attr}="${escapeAttribute(text)}"`);
    else json[name] = value;
  }
  return { attributes, json };
}

function serializeContent(items: readonly ContentItem[], profile: SchemaProfile): string {
  return items
    .map((item) => (typeof item === "string" ? escapeText(item) : serializeNode(item, profile)))
    .join("");
}

function serializeNode(node: ComponentNode, profile: SchemaProfile): string {
  const { attributes, json } = encodeProps(node, profile);
  const parts =
    node.id === undefined ? attributes : [`id="${escapeAttribute(node.id)}"`, ...attributes];
  const open = `<${node.tag}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
  const block =
    Object.keys(json).length > 0
      ? `<script type="application/json">${escapeJsonForScript(JSON.stringify(json))}</script>`
      : "";
  const body = block + serializeContent(node.content ?? [], profile);
  return body.length === 0 ? `${open} />` : `${open}>${body}</${node.tag}>`;
}

export function serializeDocument(model: DocumentModel, profile: SchemaProfile): string {
  return serializeNode(model.root, profile);
}

export function serializeFragment(items: readonly ContentItem[], profile: SchemaProfile): string {
  return serializeContent(items, profile);
}
