/** JSON value types used throughout the core (no `any` escape hatch). */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** A persisted structural node: a schema-declared component instance. */
export interface ComponentNode {
  readonly id?: string;
  readonly tag: string;
  readonly props: JsonObject;
  readonly content?: readonly ContentItem[];
}

/** Ordered mixed content: plain text or a nested component. */
export type ContentItem = string | ComponentNode;

/** A self-contained document: schema identity plus its root node. */
export interface DocumentModel {
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly root: ComponentNode;
}

export function isComponentNode(item: ContentItem): item is ComponentNode {
  return typeof item !== "string";
}
