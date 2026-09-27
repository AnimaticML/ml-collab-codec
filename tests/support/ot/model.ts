/**
 * Independent reference model for concurrent sequence edits (text code
 * points, array occurrences, child lists), written from SPEC §18.4 rather
 * than from the transform code. Every element has an identity; each edit is
 * expressed against the shared base list: insertions belong to a base gap,
 * deletions and modifications name base elements. The merged list is the
 * surviving base elements in base order with, at each gap, the insertions
 * of both sides ordered by rank (a split continuation glued to its run
 * first, ordinary insertions by stable origin, split boundaries in text
 * last so text inserted at a boundary stays on its left).
 */
export interface ModelOrigin {
  readonly replica: string;
  readonly seq: number;
  readonly ordinal: number;
}

export interface Token {
  readonly key: string;
  readonly value: unknown;
}

export type Edit =
  | {
      readonly t: "ins";
      readonly gap: number;
      readonly tokens: readonly Token[];
      readonly origin: ModelOrigin;
      /** 0 = glued continuation, 1 = ordinary insertion, 2 = text split boundary. */
      readonly rank: 0 | 1 | 2;
      /** Secondary key within a rank (split continuations follow their text offsets). */
      readonly order?: number;
    }
  | { readonly t: "del"; readonly index: number }
  | { readonly t: "mod"; readonly index: number; readonly apply: (value: unknown) => unknown };

/** Replica bytewise (UTF-16 code units equal UTF-8 byte order for the ASCII ids used), then seq, then ordinal. */
function originOrder(a: ModelOrigin, b: ModelOrigin): number {
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.seq - b.seq || a.ordinal - b.ordinal;
}

export function mergeSequence(base: readonly Token[], edits: readonly Edit[]): Token[] {
  const deleted = new Set<number>();
  const mods = new Map<string, ((value: unknown) => unknown)[]>();
  const slots = new Map<number, Extract<Edit, { t: "ins" }>[]>();
  for (const edit of edits) {
    if (edit.t === "del") deleted.add(edit.index);
    else if (edit.t === "mod") {
      const key = base[edit.index]?.key ?? "";
      mods.set(key, [...(mods.get(key) ?? []), edit.apply]);
    } else slots.set(edit.gap, [...(slots.get(edit.gap) ?? []), edit]);
  }
  const out: Token[] = [];
  for (let gap = 0; gap <= base.length; gap += 1) {
    const here = [...(slots.get(gap) ?? [])].sort(
      (x, y) =>
        x.rank - y.rank || (x.order ?? 0) - (y.order ?? 0) || originOrder(x.origin, y.origin),
    );
    for (const insertion of here) out.push(...insertion.tokens);
    const element = base[gap];
    if (gap < base.length && element !== undefined && !deleted.has(gap)) out.push(element);
  }
  return out.map((token) => {
    let value = token.value;
    for (const apply of mods.get(token.key) ?? []) value = apply(value);
    return { key: token.key, value };
  });
}

/** A copy of `value` with `path` set to `next` (undefined removes an object member). */
export function setIn(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return next;
  if (Array.isArray(value)) {
    const copy: unknown[] = [...(value as unknown[])];
    copy[Number(head)] = setIn(copy[Number(head)], rest, next);
    return copy;
  }
  const record = { ...(value as Record<string, unknown>) };
  const inner = setIn(record[String(head)], rest, next);
  if (inner === undefined) delete record[String(head)];
  else record[String(head)] = inner;
  return record;
}

export function getIn(value: unknown, path: readonly (string | number)[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  return cursor;
}
