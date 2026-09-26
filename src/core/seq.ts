import type { Origin } from "./change.ts";
import { landingIndex } from "./change.ts";

/**
 * One concurrent primitive's effect on a single ordered list (text code
 * points, array elements, or a child list), expressed in the list's
 * coordinates before that primitive applies.
 */
export type ListStep =
  | {
      readonly t: "ins";
      readonly gap: number;
      readonly count: number;
      readonly origin: Origin;
      /** A split continuation stays glued to its left neighbour and wins every gap tie. */
      readonly glue?: boolean;
      /** Payload identity used only to break a tie between identical origins. */
      readonly payload: string;
    }
  | { readonly t: "del"; readonly index: number; readonly count: number }
  | {
      readonly t: "move";
      readonly from: number;
      readonly gap: number;
      readonly origin: Origin;
      readonly payload: string;
    };

/** Decides whether the transformed insertion goes before a concurrent insertion at the same gap. */
export type TieRule = (step: Extract<ListStep, { t: "ins" | "move" }>) => boolean;

/** Element index after the step, or null when the step removed that element. */
export function mapElement(index: number, step: ListStep): number | null {
  switch (step.t) {
    case "ins":
      return index >= step.gap ? index + step.count : index;
    case "del":
      if (index < step.index) return index;
      return index >= step.index + step.count ? index - step.count : null;
    case "move": {
      const landed = landingIndex(step.from, step.gap);
      if (index === step.from) return landed;
      const without = index > step.from ? index - 1 : index;
      return without >= landed ? without + 1 : without;
    }
  }
}

/** Insertion gap after the step; a gap inside a removed range collapses to its start. */
export function mapGap(gap: number, step: ListStep, before: TieRule): number {
  switch (step.t) {
    case "ins":
      if (gap !== step.gap) return gap > step.gap ? gap + step.count : gap;
      return before(step) ? gap : gap + step.count;
    case "del":
      if (gap <= step.index) return gap;
      return gap >= step.index + step.count ? gap - step.count : step.index;
    case "move": {
      const without = gap > step.from ? gap - 1 : gap;
      const landed = landingIndex(step.from, step.gap);
      if (without !== landed) return without > landed ? without + 1 : without;
      return before(step) ? without : without + 1;
    }
  }
}

/** A deleted element that survived the step, at its new index, with its recorded item. */
interface Survivor<T> {
  readonly index: number;
  readonly item: T;
}

/**
 * Map each element of an original deleted range through the step. Elements
 * the step already removed are reported as `overlap` (with the step's own
 * index) so callers can check that both records name the same content.
 */
export function mapRange<T>(
  start: number,
  items: readonly T[],
  step: ListStep,
): { readonly survivors: Survivor<T>[]; readonly overlap: { index: number; item: T }[] } {
  const survivors: Survivor<T>[] = [];
  const overlap: { index: number; item: T }[] = [];
  items.forEach((item, offset) => {
    const mapped = mapElement(start + offset, step);
    if (mapped === null) overlap.push({ index: start + offset, item });
    else survivors.push({ index: mapped, item });
  });
  survivors.sort((x, y) => x.index - y.index);
  return { survivors, overlap };
}

/** Group survivors into contiguous runs, highest index first, so runs apply without reindexing. */
export function descendingRuns<T>(
  survivors: readonly Survivor<T>[],
): { index: number; items: T[] }[] {
  const runs: { index: number; items: T[] }[] = [];
  for (const survivor of survivors) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.index + last.items.length === survivor.index)
      last.items.push(survivor.item);
    else runs.push({ index: survivor.index, items: [survivor.item] });
  }
  return runs.reverse();
}
