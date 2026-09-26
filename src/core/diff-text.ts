import type { ChangeBuilder } from "./builder.ts";
import { alignKeys } from "./diff-align.ts";
import type { TableNode } from "./table.ts";
import { textOf } from "./table.ts";

/** One replaced code-point range of the old text. */
export interface TextHunk {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** Equal stretches this short between two edits are folded into one hunk (fewer fragments). */
const MERGE_GAP = 2;

/**
 * Code-point hunks turning `oldText` into `newText`: an LCS alignment (with
 * the same cell limit as child lists; beyond it one prefix/suffix splice),
 * so distant edits stay separate and concurrent work between them survives.
 */
export function textHunks(oldText: string, newText: string): TextHunk[] {
  const a = [...oldText];
  const b = [...newText];
  const matches = alignKeys(a, b);
  const hunks: { from: number; to: number; insert: string[] }[] = [];
  let i = 0;
  let open: { from: number; to: number; insert: string[] } | undefined;
  const flush = (): void => {
    if (open === undefined) return;
    const last = hunks[hunks.length - 1];
    if (last !== undefined && open.from - last.to <= MERGE_GAP) {
      last.insert.push(...a.slice(last.to, open.from), ...open.insert);
      last.to = open.to;
    } else hunks.push(open);
    open = undefined;
  };
  b.forEach((char, j) => {
    const match = matches[j] ?? -1;
    if (match < 0) {
      open ??= { from: i, to: i, insert: [] };
      open.insert.push(char);
      return;
    }
    if (match > i) {
      open ??= { from: i, to: i, insert: [] };
      open.to = match;
    }
    flush();
    i = match + 1;
  });
  if (i < a.length) {
    open ??= { from: i, to: i, insert: [] };
    open.to = a.length;
  }
  flush();
  return hunks.map((hunk) => ({ from: hunk.from, to: hunk.to, insert: hunk.insert.join("") }));
}

/**
 * Apply the hunks of a text segment's concatenated value onto its runs,
 * right to left so earlier offsets stay valid. Each hunk inserts at the end
 * of its replaced range (binding to the replaced content), then deletes it.
 */
export function diffText(builder: ChangeBuilder, runs: readonly TableNode[], target: string): void {
  let start = 0;
  const spans = runs.map((run) => {
    const span = { run, start, length: [...textOf(run)].length };
    start += span.length;
    return span;
  });
  for (const { from, to, insert } of textHunks(runs.map(textOf).join(""), target).reverse()) {
    const host = spans.find((span) => to >= span.start && to <= span.start + span.length);
    if (insert.length > 0 && host !== undefined)
      builder.textInsert(host.run.id, to - host.start, insert);
    for (const { run, start: offset, length } of spans) {
      const cutFrom = Math.max(from, offset) - offset;
      const cutTo = Math.min(to, offset + length) - offset;
      if (cutTo > cutFrom) builder.textDelete(run.id, cutFrom, cutTo - cutFrom);
    }
  }
}
