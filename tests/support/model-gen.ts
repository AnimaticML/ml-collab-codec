import type { EditableNode, MutableJsonValue } from "../../src/core/json-copy.ts";
import type { Rng } from "./random.ts";

/**
 * Schema-free document models for diff laws (MR12): persisted and anonymous
 * containers, mixed text, opaque nested props, and lists with duplicate
 * values. Mutations produce the structural situations the diff must keep
 * identity through: moves, wrappers around existing ids, unwraps, removals,
 * anonymous copies, retags, text edits, and list/property edits.
 */
const WORDS = ["ab", "cd", "xyz", "Ёж", "😀e", "a", " "];
const TAGS = ["p", "sec", "em", "note"];

function text(r: Rng): string {
  return Array.from({ length: 1 + r.int(3) }, () => r.pick(WORDS)).join("");
}

function inline(r: Rng, ids: { next: number }, depth: number): string | EditableNode {
  if (r.chance(0.5)) return text(r);
  const persisted = r.chance(0.4);
  const node: EditableNode = {
    tag: r.pick(["em", "note"]),
    props: r.chance(0.3) ? { opaque: { deep: [1, 1, { k: "v" }] } } : {},
    content: depth < 3 ? [text(r)] : [],
  };
  if (persisted) node.id = `n${ids.next++}`;
  return node;
}

function block(r: Rng, ids: { next: number }, depth: number): EditableNode {
  const container = depth < 2 && r.chance(0.3);
  const node: EditableNode = {
    tag: container ? "sec" : "p",
    props: { n: r.int(3), tags: ["a", "a", "b"].slice(0, r.int(4)) },
    content: container
      ? Array.from({ length: 1 + r.int(3) }, () => block(r, ids, depth + 1))
      : Array.from({ length: 1 + r.int(4) }, () => inline(r, ids, depth + 1)),
  };
  if (!container || r.chance(0.5)) node.id = `n${ids.next++}`;
  return node;
}

export function randomModel(r: Rng): EditableNode {
  const ids = { next: 0 };
  const root: EditableNode = {
    tag: "doc",
    props: {
      meta: { title: "t", labels: ["x", "x"] },
      items: [{ name: "a", tags: ["q", "q"] }, "dup", "dup", { name: "a", tags: ["q", "q"] }],
    },
    content: Array.from({ length: 2 + r.int(3) }, () => block(r, ids, 0)),
  };
  if (r.chance(0.3)) root.id = "root-1";
  return root;
}

interface Place {
  readonly parent: EditableNode;
  readonly index: number;
  readonly node: EditableNode;
}

function places(node: EditableNode, into: Place[] = []): Place[] {
  node.content.forEach((item, index) => {
    if (typeof item === "string") return;
    into.push({ parent: node, index, node: item });
    places(item, into);
  });
  return into;
}

function contains(outer: EditableNode, inner: EditableNode): boolean {
  return outer === inner || outer.content.some((c) => typeof c !== "string" && contains(c, inner));
}

function stripIds(node: EditableNode): EditableNode {
  return {
    tag: node.tag,
    props: structuredClone(node.props),
    content: node.content.map((c) => (typeof c === "string" ? c : stripIds(c))),
  };
}

function editText(r: Rng, value: string): string {
  const chars = [...value];
  for (let k = 0; k < 1 + r.int(2); k += 1) {
    const at = r.int(chars.length + 1);
    if (r.chance(0.5) && at < chars.length) chars.splice(at, 1 + r.int(2));
    else chars.splice(at, 0, ...r.pick(WORDS));
  }
  return chars.join("");
}

function editProps(r: Rng, root: EditableNode, target: EditableNode): void {
  const items = root.props["items"] as MutableJsonValue[];
  const choice = r.int(5);
  if (choice === 0) (root.props["meta"] as { title: string }).title = text(r);
  else if (choice === 1) items.splice(r.int(items.length + 1), 0, "dup");
  else if (choice === 2 && items.length > 0) items.splice(r.int(items.length), 1);
  else if (choice === 3) {
    const first = items.find((item) => typeof item === "object" && item !== null);
    if (first !== undefined) (first as { name: string }).name = text(r);
  } else target.props["extra"] = { nested: { list: [r.int(3), r.int(3)] } };
}

/** Apply one structural or value mutation in place; the result is a valid model. */
function mutate(r: Rng, root: EditableNode, next: { id: number }): void {
  const all = places(root);
  const place = all.length > 0 ? r.pick(all) : undefined;
  const choice = r.int(9);
  if (place === undefined || choice === 0) return editProps(r, root, place?.node ?? root);
  const { parent, index, node } = place;
  if (choice === 1) {
    parent.content.splice(index, 1);
    const hosts = [root, ...places(root).map((p) => p.node)].filter((h) => !contains(node, h));
    const host = r.pick(hosts);
    host.content.splice(r.int(host.content.length + 1), 0, node);
  } else if (choice === 2) {
    const end = index + 1 + r.int(parent.content.length - index);
    const wrapped = parent.content.splice(index, end - index);
    const wrapper: EditableNode = { tag: "sec", props: {}, content: wrapped };
    if (r.chance(0.5)) wrapper.id = `w${next.id++}`;
    parent.content.splice(index, 0, wrapper);
  } else if (choice === 3) parent.content.splice(index, 1, ...node.content);
  else if (choice === 4) parent.content.splice(index, 1);
  else if (choice === 5) parent.content.splice(index + 1, 0, stripIds(node));
  else if (choice === 6) node.tag = r.pick(TAGS.filter((t) => t !== node.tag));
  else if (choice === 7) {
    const at = node.content.findIndex((c) => typeof c === "string");
    if (at >= 0) node.content[at] = editText(r, node.content[at] as string);
    else node.content.push(text(r));
  } else editProps(r, root, node);
}

export function mutateModel(r: Rng, model: EditableNode, steps: number): EditableNode {
  const copy = structuredClone(model);
  const next = { id: 0 };
  for (let k = 0; k < steps; k += 1) mutate(r, copy, next);
  return copy;
}

/** The same model with every props object's keys in reverse order (irrelevant ordering). */
export function reorderKeys(node: EditableNode): EditableNode {
  const flip = (value: MutableJsonValue): MutableJsonValue => {
    if (Array.isArray(value)) return value.map(flip);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, flip(value[key] as MutableJsonValue)]),
    );
  };
  return {
    ...(node.id === undefined ? {} : { id: node.id }),
    tag: node.tag,
    props: flip(node.props) as EditableNode["props"],
    content: node.content.map((c) => (typeof c === "string" ? c : reorderKeys(c))),
  };
}
