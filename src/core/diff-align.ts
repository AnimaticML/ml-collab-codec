/**
 * Ordered alignment of a current child list with a target child list by
 * identity keys (`id:<persisted id>`, `anon:<tag>`, `#text`). The common
 * prefix and suffix are matched directly; the remaining middle uses a
 * longest-common-subsequence table when it is at most `LCS_CELL_LIMIT`
 * cells, and otherwise stays unmatched (the documented coarse fallback:
 * the middle is replaced, persisted nodes are still moved, never recreated).
 */
const LCS_CELL_LIMIT = 4_000_000;

/** For each target index, the matched current index (or -1). */
export function alignKeys(current: readonly string[], target: readonly string[]): number[] {
  const matches = target.map(() => -1);
  let prefix = 0;
  while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix]) {
    matches[prefix] = prefix;
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < target.length - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    matches[target.length - 1 - suffix] = current.length - 1 - suffix;
    suffix += 1;
  }
  const a = current.slice(prefix, current.length - suffix);
  const b = target.slice(prefix, target.length - suffix);
  if (a.length > 0 && b.length > 0 && (a.length + 1) * (b.length + 1) <= LCS_CELL_LIMIT)
    for (const [i, j] of lcsPairs(a, b)) matches[prefix + j] = prefix + i;
  return matches;
}

/** Matched index pairs of one longest common subsequence (deterministic tie-breaking). */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number))
      i += 1;
    else j += 1;
  }
  return pairs;
}
