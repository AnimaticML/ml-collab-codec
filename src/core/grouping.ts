import type { Change } from "./change.ts";
import { codePointLength } from "./change.ts";

export type EditKind = "insertText" | "deleteText" | "set" | "other";

/** Classification of one authored local change, used only by grouping/coalescing policies. */
export interface EditShape {
  readonly kind: EditKind;
  /** Text run id or `node/path` of a value write; empty for mixed changes. */
  readonly target: string;
  readonly start: number;
  readonly end: number;
}

export function classify(changes: readonly Change[]): EditShape {
  const [first] = changes;
  if (changes.length === 1 && first !== undefined) {
    if (first.kind === "textInsert")
      return {
        kind: "insertText",
        target: first.node,
        start: first.offset,
        end: first.offset + codePointLength(first.text),
      };
    if (first.kind === "textDelete")
      return {
        kind: "deleteText",
        target: first.node,
        start: first.offset,
        end: first.offset + codePointLength(first.text),
      };
    if (first.kind === "set")
      return { kind: "set", target: `${first.node}/${first.path.join("/")}`, start: 0, end: 0 };
  }
  return { kind: "other", target: "", start: 0, end: 0 };
}

export interface PreviousLocalChange {
  readonly group: string;
  readonly shape: EditShape;
  readonly at: number;
  readonly explicitToken: string | undefined;
}

/** Read-only facts a history policy may use (v3 §7.4). */
export interface GroupingContext {
  readonly actor: string;
  readonly session: string;
  /** Open explicit gesture/task token, if the application began one. */
  readonly explicitToken: string | undefined;
  readonly previous: PreviousLocalChange | undefined;
  readonly current: EditShape;
  readonly now: number;
  /** A remote document change was applied since the previous local change. */
  readonly remoteSincePrevious: boolean;
  /** The application explicitly closed the previous group. */
  readonly closed: boolean;
}

export interface HistoryPolicy {
  group(context: GroupingContext): "extend" | "start-new";
}

/** Read-only facts for pre-send compression of an unsent change into the previous unsent request. */
export interface UnsentCoalescingContext {
  readonly sameGroup: boolean;
  readonly previousUnsent: boolean;
  readonly previous: EditShape;
  readonly current: EditShape;
  readonly explicitToken: string | undefined;
}

export interface CoalescingPolicy {
  allow(context: UnsentCoalescingContext): boolean;
}

function adjacent(previous: EditShape, current: EditShape): boolean {
  if (previous.target !== current.target || previous.kind !== current.kind) return false;
  if (current.kind === "insertText") return current.start === previous.end;
  if (current.kind === "deleteText")
    return current.end === previous.start || current.start === previous.start;
  return false;
}

/**
 * Conservative default (engineering default, not a product rule): an open
 * explicit gesture/task token always extends its group; otherwise adjacent
 * own typing/deletion of the same run within `gapMs` extends, and any
 * explicit close, incompatible action, or applied remote change starts anew.
 */
export function typingHistoryPolicy(gapMs = 1000): HistoryPolicy {
  return {
    group(context) {
      const previous = context.previous;
      if (previous === undefined || context.closed) return "start-new";
      if (context.explicitToken !== undefined)
        return previous.explicitToken === context.explicitToken ? "extend" : "start-new";
      if (previous.explicitToken !== undefined || context.remoteSincePrevious) return "start-new";
      if (context.now - previous.at > gapMs || context.now < previous.at) return "start-new";
      return adjacent(previous.shape, context.current) ? "extend" : "start-new";
    },
  };
}

/** Compress unsent typing and same-field replacements inside one group; nothing else. */
export const conservativeCoalescing: CoalescingPolicy = {
  allow: (context) =>
    context.sameGroup &&
    context.previousUnsent &&
    context.previous.kind === context.current.kind &&
    context.previous.target === context.current.target &&
    context.current.kind !== "other",
};

/** Veto all compression, e.g. for a trajectory recorder whose every sample is data. */
export const noCoalescing: CoalescingPolicy = { allow: () => false };
