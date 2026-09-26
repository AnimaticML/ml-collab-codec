import type { JsonObject, JsonValue } from "./types.ts";
import type { Change, Origin, SubtreeRecord } from "./change.ts";
import { codePointLength } from "./change.ts";
import { applyChangeTo } from "./apply.ts";
import { readSubtree } from "./apply-structure.ts";
import { getAtPath } from "./json-path.ts";
import type { PropPath } from "./json-path.ts";
import type { Table, TableNode } from "./table.ts";
import { TEXT_TAG, textOf } from "./table.ts";
import { ApplyError, StagedTable } from "./staging.ts";
import { deepEqual } from "./normalize.ts";

/** A node to create: persisted nodes carry their schema-selected id; others get an internal handle. */
export interface NodeSpec {
  readonly tag: string;
  readonly id?: string;
  readonly props?: JsonObject;
  readonly children?: readonly (NodeSpec | string)[];
}

/** Stable authorship of the change being built: replica incarnation plus its origin sequence. */
export interface AuthoredBy {
  readonly replica: string;
  readonly seq: number;
}

/**
 * Builds complete self-contained reversible records (v3 §6.1). Each command
 * reads the current staged context once, records before-values/removed
 * payloads, and applies itself so later commands in the same change see it.
 */
export class ChangeBuilder {
  private readonly staged: StagedTable;
  private readonly built: Change[] = [];
  private handles = 0;

  constructor(
    base: Table,
    private readonly author: AuthoredBy,
  ) {
    this.staged = new StagedTable(base);
  }

  get changes(): readonly Change[] {
    return this.built;
  }

  /** Read one staged row without materializing a whole table. */
  read(id: string): TableNode | undefined {
    return this.staged.get(id);
  }

  /** The staged state after the commands so far. */
  current(): Table {
    return this.staged.freeze();
  }

  private origin(): Origin {
    return { replica: this.author.replica, seq: this.author.seq, ordinal: this.built.length };
  }

  private push(change: Change): void {
    applyChangeTo(this.staged, change);
    this.built.push(change);
  }

  /**
   * Append an already complete record (an undo/redo handle's primitive).
   * Its stable origin is kept: a restored contribution is not a new insertion.
   */
  record(change: Change): this {
    this.push(change);
    return this;
  }

  /** Internal handle for an anonymous node or text run, unique per replica and change. */
  newHandle(): string {
    this.handles += 1;
    return `${this.author.replica}~${this.author.seq}.${this.handles}`;
  }

  set(node: string, path: PropPath | string, value: JsonValue | undefined): this {
    const fullPath = typeof path === "string" ? [path] : path;
    const before = getAtPath(this.staged.require(node).props, fullPath);
    if (
      before === undefined ? value === undefined : value !== undefined && deepEqual(before, value)
    )
      return this;
    this.push({
      kind: "set",
      node,
      path: fullPath,
      ...(before === undefined ? {} : { before }),
      ...(value === undefined ? {} : { after: value }),
      origin: this.origin(),
    });
    return this;
  }

  delta(node: string, path: PropPath | string, by: number): this {
    this.push({
      kind: "delta",
      node,
      path: typeof path === "string" ? [path] : path,
      by,
      origin: this.origin(),
    });
    return this;
  }

  private array(node: string, path: PropPath): readonly JsonValue[] {
    const value = getAtPath(this.staged.require(node).props, path);
    if (!Array.isArray(value)) throw new ApplyError("preconditionFailed", "target is not an array");
    return value;
  }

  arrayInsert(node: string, path: PropPath, index: number, values: readonly JsonValue[]): this {
    this.push({ kind: "arrayInsert", node, path, index, values, origin: this.origin() });
    return this;
  }

  /** Remove `count` occurrences starting at a concrete index in the current context. */
  arrayDelete(node: string, path: PropPath, index: number, count = 1): this {
    const values = this.array(node, path).slice(index, index + count);
    if (values.length !== count) throw new ApplyError("outOfRange", "array range out of bounds");
    this.push({ kind: "arrayDelete", node, path, index, values, origin: this.origin() });
    return this;
  }

  arrayMove(node: string, path: PropPath, from: number, gap: number): this {
    if (gap === from || gap === from + 1) return this;
    this.push({ kind: "arrayMove", node, path, from, gap, origin: this.origin() });
    return this;
  }

  textInsert(node: string, offset: number, text: string): this {
    if (text.length > 0)
      this.push({ kind: "textInsert", node, offset, text, origin: this.origin() });
    return this;
  }

  textDelete(node: string, offset: number, count: number): this {
    const chars = [...textOf(this.staged.require(node))];
    if (offset < 0 || offset + count > chars.length)
      throw new ApplyError("outOfRange", "text range out of bounds");
    const text = chars.slice(offset, offset + count).join("");
    if (text.length > 0)
      this.push({ kind: "textDelete", node, offset, text, origin: this.origin() });
    return this;
  }

  /**
   * Replace [from, to) with `text`. The insertion is recorded first, at the
   * end of the replaced range, so the replacement binds (left affinity) to
   * the replaced content and follows it through concurrent wraps, splits,
   * and moves; then the original range is deleted.
   */
  textReplace(node: string, from: number, to: number, text: string): this {
    return this.textInsert(node, to, text).textDelete(node, from, to - from);
  }

  private subtreeFrom(spec: NodeSpec | string): SubtreeRecord {
    if (typeof spec === "string")
      return {
        id: this.newHandle(),
        tag: TEXT_TAG,
        props: { value: spec },
        persisted: false,
        children: [],
      };
    return {
      id: spec.id ?? this.newHandle(),
      tag: spec.tag,
      props: spec.props ?? {},
      persisted: spec.id !== undefined,
      children: (spec.children ?? []).map((child) => this.subtreeFrom(child)),
    };
  }

  /** Insert a node (with children) at child position `index`; returns its id. */
  insertNode(parent: string, index: number, spec: NodeSpec | string): string {
    const subtree = this.subtreeFrom(spec);
    this.push({ kind: "nodeInsert", parent, index, subtree, origin: this.origin() });
    return subtree.id;
  }

  deleteNode(id: string): this {
    const { parent, index } = this.position(id);
    this.push({
      kind: "nodeDelete",
      parent,
      index,
      subtree: readSubtree(this.staged, id),
      origin: this.origin(),
    });
    return this;
  }

  /** Move a node to insertion gap `gap` of `toParent` (a gap in the list before the move). */
  moveNode(id: string, toParent: string, gap: number): this {
    const { parent, index } = this.position(id);
    if (parent === toParent && (gap === index || gap === index + 1)) return this;
    this.push({
      kind: "nodeMove",
      node: id,
      fromParent: parent,
      fromIndex: index,
      toParent,
      gap,
      origin: this.origin(),
    });
    return this;
  }

  /** Split text run `node` at `offset`; returns the id of the new tail run. */
  split(node: string, offset: number): string {
    const { parent, index } = this.position(node);
    const other = this.newHandle();
    this.push({ kind: "split", node, other, offset, parent, index, origin: this.origin() });
    return other;
  }

  /** Merge text run `node` with the following sibling run. */
  merge(node: string): this {
    const { parent, index } = this.position(node);
    const other = this.staged.require(parent).children[index + 1];
    if (other === undefined) throw new ApplyError("outOfRange", "no following run to merge");
    const offset = codePointLength(textOf(this.staged.require(node)));
    this.push({ kind: "merge", node, other, offset, parent, index, origin: this.origin() });
    return this;
  }

  position(id: string): { parent: string; index: number } {
    const parent = this.staged.require(id).parentId;
    if (parent === null) throw new ApplyError("invalidTarget", "the root has no position");
    return { parent, index: this.staged.require(parent).children.indexOf(id) };
  }
}
