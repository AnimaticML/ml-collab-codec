import type { JsonObject, JsonValue } from "./types.ts";
import type { PropPath } from "./json-path.ts";

/**
 * Stable effect origin (v3 §5.4/§5.6): the replica incarnation that authored
 * a change, that change's local origin sequence, and the component ordinal
 * inside the authored change. Rebase, expansion, composition, and inversion
 * keep the token; they never mint a new one.
 */
export interface Origin {
  readonly replica: string;
  readonly seq: number;
  readonly ordinal: number;
}

/** A complete deleted/inserted subtree: identities, tags, props, and child order. */
export interface SubtreeRecord {
  readonly id: string;
  readonly tag: string;
  readonly props: JsonObject;
  readonly persisted: boolean;
  readonly children: readonly SubtreeRecord[];
}

interface Base {
  readonly origin: Origin;
}

/**
 * One self-contained reversible primitive (operation format `sdl.ops/1`).
 * Every field needed to invert the record is inside the record; before
 * values and removed payloads double as checked preconditions. Positions are
 * code points (text), element indexes (arrays), or child indexes; a `gap`
 * is an insertion point in the list as it is before this primitive applies.
 */
export type Change =
  | (Base & {
      readonly kind: "set";
      readonly node: string;
      readonly path: PropPath;
      readonly before?: JsonValue;
      readonly after?: JsonValue;
    })
  | (Base & {
      readonly kind: "delta";
      readonly node: string;
      readonly path: PropPath;
      readonly by: number;
    })
  | (Base &
      ArrayTarget & {
        readonly kind: "arrayInsert";
        readonly index: number;
        readonly values: readonly JsonValue[];
      })
  | (Base &
      ArrayTarget & {
        readonly kind: "arrayDelete";
        readonly index: number;
        readonly values: readonly JsonValue[];
      })
  | (Base &
      ArrayTarget & { readonly kind: "arrayMove"; readonly from: number; readonly gap: number })
  | (Base & {
      readonly kind: "textInsert";
      readonly node: string;
      readonly offset: number;
      readonly text: string;
    })
  | (Base & {
      readonly kind: "textDelete";
      readonly node: string;
      readonly offset: number;
      readonly text: string;
    })
  | (Base & {
      readonly kind: "nodeInsert";
      readonly parent: string;
      readonly index: number;
      readonly subtree: SubtreeRecord;
    })
  | (Base & {
      readonly kind: "nodeDelete";
      readonly parent: string;
      readonly index: number;
      readonly subtree: SubtreeRecord;
    })
  | (Base & {
      readonly kind: "nodeMove";
      readonly node: string;
      readonly fromParent: string;
      readonly fromIndex: number;
      readonly toParent: string;
      readonly gap: number;
    })
  | (Base & SplitShape & { readonly kind: "split" })
  | (Base & SplitShape & { readonly kind: "merge" });

interface ArrayTarget {
  readonly node: string;
  readonly path: PropPath;
}

/** `split` cuts text run `node` at `offset`; the tail becomes run `other` at `index + 1` of `parent`. `merge` is its exact inverse. */
interface SplitShape {
  readonly node: string;
  readonly other: string;
  readonly offset: number;
  readonly parent: string;
  readonly index: number;
}

export type ChangeKind = Change["kind"];
export type ChangeOf<K extends ChangeKind> = Extract<Change, { kind: K }>;

export const OPERATION_FORMAT = "sdl.ops/1";

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** Bytewise comparison of canonical ASCII replica ids (never locale-sensitive). */
function compareReplica(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** §5.6 order for genuinely concurrent same-gap insertions. */
export function compareOrigin(a: Origin, b: Origin): number {
  return compareReplica(a.replica, b.replica) || a.seq - b.seq || a.ordinal - b.ordinal;
}

/** Inverse of one primitive, derived from the record alone (no state, history, or cache). */
export function invertChange(change: Change): Change {
  switch (change.kind) {
    case "set": {
      const { before, after, ...rest } = change;
      return {
        ...rest,
        ...(after === undefined ? {} : { before: after }),
        ...(before === undefined ? {} : { after: before }),
      };
    }
    case "delta":
      return { ...change, by: -change.by };
    case "arrayInsert":
      return { ...change, kind: "arrayDelete" };
    case "arrayDelete":
      return { ...change, kind: "arrayInsert" };
    case "arrayMove": {
      const at = landingIndex(change.from, change.gap);
      return { ...change, from: at, gap: change.from > at ? change.from + 1 : change.from };
    }
    case "textInsert":
      return { ...change, kind: "textDelete" };
    case "textDelete":
      return { ...change, kind: "textInsert" };
    case "nodeInsert":
      return { ...change, kind: "nodeDelete" };
    case "nodeDelete":
      return { ...change, kind: "nodeInsert" };
    case "nodeMove":
      return invertMove(change);
    case "split":
      return { ...change, kind: "merge" };
    case "merge":
      return { ...change, kind: "split" };
  }
}

function invertMove(change: ChangeOf<"nodeMove">): ChangeOf<"nodeMove"> {
  const same = change.fromParent === change.toParent;
  const at = same ? landingIndex(change.fromIndex, change.gap) : change.gap;
  const back = same && change.fromIndex > at ? change.fromIndex + 1 : change.fromIndex;
  return {
    ...change,
    fromParent: change.toParent,
    fromIndex: at,
    toParent: change.fromParent,
    gap: back,
  };
}

/** Index an element lands on when moved from `from` to insertion gap `gap` of the same list. */
export function landingIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/** Inverse of a sequential composite: inverted parts in reverse order. */
export function invertChanges(changes: readonly Change[]): Change[] {
  return changes.map(invertChange).reverse();
}

export function subtreeIds(subtree: SubtreeRecord, into: Set<string> = new Set()): Set<string> {
  into.add(subtree.id);
  for (const child of subtree.children) subtreeIds(child, into);
  return into;
}

/** Nodes whose existence a change requires (targets, parents, move endpoints). */
export function requiredNodes(change: Change): readonly string[] {
  switch (change.kind) {
    case "nodeInsert":
    case "nodeDelete":
      return [change.parent];
    case "nodeMove":
      return [change.node, change.fromParent, change.toParent];
    case "split":
      return [change.node, change.parent];
    case "merge":
      return [change.node, change.other, change.parent];
    default:
      return [change.node];
  }
}

/** Node ids a change destroys (a merge absorbs, rather than destroys, its second run). */
export function destroyedNodes(change: Change): ReadonlySet<string> {
  return change.kind === "nodeDelete" ? subtreeIds(change.subtree) : new Set();
}
