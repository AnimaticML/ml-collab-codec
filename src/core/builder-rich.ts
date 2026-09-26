import { isJsonArray } from "./types.ts";
import type { JsonValue } from "./types.ts";
import type { ChangeBuilder, NodeSpec } from "./builder.ts";
import { getAtPath } from "./json-path.ts";
import type { PropPath } from "./json-path.ts";
import { deepEqual } from "./normalize.ts";
import type { Table } from "./table.ts";
import { TEXT_TAG } from "./table.ts";

/**
 * Rich-text builders compile into the generic primitives (SPEC 7): a wrap
 * is split + insert + identity-preserving move, so concurrent edits to the
 * wrapped text follow it instead of being lost to delete-and-recreate.
 */
export function wrapText(
  builder: ChangeBuilder,
  run: string,
  from: number,
  to: number,
  wrapper: NodeSpec,
): string {
  const tail = builder.split(run, to);
  const middle = builder.split(run, from);
  const { parent, index } = builder.position(middle);
  const id = builder.insertNode(parent, index, { ...wrapper, children: [] });
  builder.moveNode(middle, id, 0);
  void tail;
  return id;
}

/** Unwrap: move the wrapper's children to its position, then delete the empty wrapper. */
export function unwrap(builder: ChangeBuilder, wrapper: string): void {
  const { parent, index } = builder.position(wrapper);
  const kids = builder.current().get(wrapper)?.children ?? [];
  kids.forEach((child, i) => builder.moveNode(child, parent, index + i));
  builder.deleteNode(wrapper);
}

/** Split container `container` at text run `run`/`offset`: the tail and later siblings move to a new container. */
export function splitContainer(
  builder: ChangeBuilder,
  container: string,
  run: string,
  offset: number,
  spec: Omit<NodeSpec, "children">,
): string {
  const tail = builder.split(run, offset);
  const { parent, index } = builder.position(container);
  const created = builder.insertNode(parent, index + 1, { ...spec, children: [] });
  const siblings = builder.current().get(container)?.children ?? [];
  siblings.slice(siblings.indexOf(tail)).forEach((child, i) => builder.moveNode(child, created, i));
  return created;
}

/** Merge `second` into the preceding sibling container `first`, joining text runs at the boundary. */
export function mergeContainers(builder: ChangeBuilder, first: string, second: string): void {
  const table = builder.current();
  const last = table.get(first)?.children.at(-1);
  const moved = table.get(second)?.children ?? [];
  const base = table.get(first)?.children.length ?? 0;
  moved.forEach((child, i) => builder.moveNode(child, first, base + i));
  const next = builder.current();
  const boundary = moved[0];
  if (
    last !== undefined &&
    boundary !== undefined &&
    next.get(last)?.tag === TEXT_TAG &&
    next.get(boundary)?.tag === TEXT_TAG
  )
    builder.merge(last);
  builder.deleteNode(second);
}

export type OccurrenceLookup =
  | { readonly status: "unique"; readonly index: number }
  | { readonly status: "ambiguous"; readonly indexes: readonly number[] }
  | { readonly status: "none" };

/**
 * Resolve a user's value-based selection to a concrete occurrence in a
 * known state. Several equal occurrences are reported as ambiguous; the
 * library never encodes value search as operation identity.
 */
export function findOccurrence(
  table: Table,
  node: string,
  path: PropPath,
  value: JsonValue,
): OccurrenceLookup {
  const array = getAtPath(table.get(node)?.props ?? {}, path);
  if (!isJsonArray(array)) return { status: "none" };
  const indexes = array.flatMap((item, i) => (deepEqual(item, value) ? [i] : []));
  if (indexes.length === 0) return { status: "none" };
  return indexes.length === 1
    ? { status: "unique", index: indexes[0] as number }
    : { status: "ambiguous", indexes };
}
