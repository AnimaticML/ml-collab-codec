import type { JsonValue } from "./types.ts";
import type { PropertySchema, SchemaProfile } from "./schema.ts";
import { getComponentSchema, propertyAtPath } from "./schema.ts";
import { type Diagnostic, diag } from "./diagnostics.ts";
import { attributePathToPropertyPath } from "./naming.ts";
import { PropsBuilder } from "./merge.ts";
import type { RawAttribute, RawElement, RawJsonBlock, RawNode } from "./tokenizer.ts";

/**
 * Syntax decoding only: tagged elements become raw `{ id?, tag, props,
 * content }` trees. Attribute strings are decoded by their declared type and
 * JSON blocks are merged in source order; unknown (opaque) components keep
 * their attributes as strings and their JSON blocks as structured values.
 * Normalization and validation happen afterwards, in `normalizeDocument`,
 * exactly as for every other entry path.
 */
interface RawTree {
  readonly id?: string;
  readonly tag: string;
  readonly props: Readonly<Record<string, JsonValue>>;
  readonly content: readonly (string | RawTree)[];
}

const NUMBER_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function decodeAttribute(schema: PropertySchema | undefined, raw: string): JsonValue {
  const type = schema?.type;
  if (type === "number" || type === "integer") return NUMBER_LITERAL.test(raw) ? Number(raw) : raw;
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  if (type === "array" && schema?.commaShorthand === true) {
    const members = raw.length === 0 ? [] : raw.split(",");
    return members.map((member) => decodeAttribute(schema.items, member));
  }
  return raw;
}

function applyAttribute(
  builder: PropsBuilder,
  attribute: RawAttribute,
  root: PropertySchema | undefined,
  path: string,
): string | null {
  const segments = attributePathToPropertyPath(attribute.rawName);
  if (segments.length === 1 && segments[0] === "id") return attribute.value;
  builder.setAttributePath(
    segments,
    decodeAttribute(propertyAtPath(root, segments), attribute.value),
    path,
  );
  return null;
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

function buildNode(
  element: RawElement,
  profile: SchemaProfile,
  path: string,
  diagnostics: Diagnostic[],
): RawTree {
  const root = getComponentSchema(profile, element.tag)?.props;
  const builder = new PropsBuilder();
  let id: string | undefined;
  for (const attribute of element.attributes) {
    const found = applyAttribute(builder, attribute, root, path);
    if (found !== null) id = found;
  }
  const content: (string | RawTree)[] = [];
  for (const child of element.children) {
    if (typeof child === "string") content.push(child);
    else if (child.kind === "json") applyJsonBlock(builder, child, path, diagnostics);
    else content.push(buildNode(child, profile, `${path}/${child.tag}`, diagnostics));
  }
  diagnostics.push(...builder.diagnostics);
  const node = { tag: element.tag, props: builder.build(), content };
  return id === undefined ? node : { id, ...node };
}

export function buildFragment(
  nodes: readonly RawNode[],
  profile: SchemaProfile,
  path: string,
): { items: (string | RawTree)[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const items: (string | RawTree)[] = [];
  for (const node of nodes) {
    if (typeof node === "string") items.push(node);
    else if (node.kind === "element")
      items.push(buildNode(node, profile, `${path}/${node.tag}`, diagnostics));
    else diagnostics.push(diag("invalidNesting", path, "unexpected top-level JSON block"));
  }
  return { items, diagnostics };
}
