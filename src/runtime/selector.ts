import type { DocumentSnapshot, DocumentStore } from "../core/store.ts";

export interface Selector<T> {
  /** Latest value; recomputed only when one of the selected inputs changed identity. */
  get(): T;
}

/**
 * Functional consumer of the same store (v3 §4.5): explicit relevant
 * inputs (rows are structurally shared, so identity is a revision token),
 * memoized and evaluated late, only when read.
 */
export function createSelector<I extends readonly unknown[], T>(
  store: DocumentStore,
  inputs: (snapshot: DocumentSnapshot) => I,
  compute: (...args: [...I]) => T,
): Selector<T> {
  let lastInputs: I | undefined;
  let lastValue: T | undefined;
  return {
    get(): T {
      const next = inputs(store.getSnapshot());
      if (
        lastInputs !== undefined &&
        next.length === lastInputs.length &&
        next.every((value, i) => Object.is(value, lastInputs?.[i]))
      )
        return lastValue as T;
      lastInputs = next;
      lastValue = compute(...next);
      return lastValue;
    },
  };
}
