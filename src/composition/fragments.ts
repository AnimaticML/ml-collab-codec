import { propertyAtPath } from "../core/schema.ts";
import type { SchemaProfile } from "../core/schema.ts";
import type { PropPath } from "../core/json-path.ts";
import type { ComponentNode, ContentItem, JsonObject, JsonValue } from "../core/types.ts";
import { isJsonArray, isJsonObject } from "../core/types.ts";
import { fail, record, token } from "./native.ts";

export function readFragment(value: JsonValue | undefined, at: string, depth = 0): ContentItem[] {
  if (value === undefined) return [];
  if (!isJsonArray(value) || depth > 64) fail(at, "invalid fragment");
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!isJsonObject(item) || !isJsonObject(item["props"])) fail(at, "invalid fragment node");
    const id = item["id"] === undefined ? undefined : token(item["id"], at);
    return {
      tag: token(item["tag"], at),
      ...(id === undefined ? {} : { id }),
      props: record(item["props"]),
      content: readFragment(item["content"], at, depth + 1),
    };
  });
}

function visitProps(
  node: ComponentNode,
  schema: SchemaProfile,
  map: (role: "definition" | "reference", value: string) => string,
): JsonObject {
  const props = Object.hasOwn(schema.components, node.tag)
    ? schema.components[node.tag]?.props
    : undefined;
  const visit = (value: JsonValue, path: PropPath): JsonValue => {
    const role = propertyAtPath(props, path)?.reference;
    if (role !== undefined && typeof value === "string") return map(role, value);
    if (isJsonArray(value)) return value.map((item, i) => visit(item, [...path, i]));
    if (isJsonObject(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]),
      );
    return value;
  };
  return Object.fromEntries(
    Object.entries(node.props).map(([name, value]) => [name, visit(value, [name])]),
  );
}

/** Copy a contiguous fragment, assigning fresh structural IDs and declared internal keys. */
export function copyCompositionFragment(
  fragment: readonly ContentItem[],
  schema: SchemaProfile,
  allocate: () => string,
): readonly ContentItem[] {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  const fresh = (): string => {
    const id = allocate();
    if (id.length === 0 || used.has(id))
      fail(id, "allocator returned a duplicate or empty identity");
    used.add(id);
    return id;
  };
  const collect = (items: readonly ContentItem[]): void => {
    for (const item of items) {
      if (typeof item === "string") continue;
      visitProps(item, schema, (role, key) => {
        if (role === "definition") {
          if (keys.has(key)) fail(key, "duplicate definition key in fragment");
          keys.set(key, fresh());
        }
        return key;
      });
      collect(item.content ?? []);
    }
  };
  const copy = (items: readonly ContentItem[]): ContentItem[] =>
    items.map((item) =>
      typeof item === "string"
        ? item
        : {
            tag: item.tag,
            ...(item.id === undefined ? {} : { id: fresh() }),
            props: visitProps(item, schema, (_role, key) => keys.get(key) ?? key),
            content: copy(item.content ?? []),
          },
    );
  collect(fragment);
  return copy(fragment);
}
