import type { ComponentNode } from "./types.ts";
import { isComponentNode } from "./types.ts";

export interface Located {
  readonly node: ComponentNode;
  readonly path: readonly string[];
}

function search(node: ComponentNode, id: string, path: readonly string[]): Located | undefined {
  if (node.id === id) return { node, path };
  for (const [index, item] of (node.content ?? []).entries()) {
    if (!isComponentNode(item)) continue;
    const found = search(item, id, [...path, `${node.tag}[${index}]`]);
    if (found) return found;
  }
  return undefined;
}

/** Find a stable-identity node anywhere in the tree, with its path from root. */
export function findNodeById(root: ComponentNode, id: string): Located | undefined {
  return search(root, id, []);
}
