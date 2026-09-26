export interface TestSource {
  path: string;
  source: string;
}

/** Inventory check only: real assertions and execution are still required. */
export function inspectAcceptance(
  ids: readonly string[],
  sources: readonly TestSource[],
  hasImplementationEntry: boolean,
): string[] {
  const problems: string[] = [];
  if (ids.length === 0) problems.push("No baseline scenario IDs were found.");
  if (new Set(ids).size !== ids.length) problems.push("Duplicate baseline scenario IDs.");
  if (!hasImplementationEntry) problems.push("Missing implementation entry: src/index.ts.");

  const active = new Set<string>();
  for (const { path, source } of sources) {
    // Keep baseline cases as literal test("C01 ...", callback) declarations.
    const declarations =
      /\b(?:test|it)(?:\.(todo|skip|only))?\s*\(\s*(["'`])((?:MR|[CSIOPVQR])\d{2})\b(?:\\.|(?!\2)[\s\S])*?\2\s*([,)])/g;
    for (const match of source.matchAll(declarations)) {
      const [, modifier, , id, delimiter] = match;
      if (id === undefined) continue;
      if (!ids.includes(id)) problems.push(`${path}: unknown scenario ${id}.`);
      if (modifier === undefined && delimiter === ",") active.add(id);
    }
    if (/\b(?:test|it|describe)\.(?:todo|skip|only)\s*\(/.test(source)) {
      problems.push(`${path}: acceptance TODO, skip, or focus remains.`);
    }
  }
  for (const id of ids) {
    if (!active.has(id)) problems.push(`${id}: no active literal baseline test.`);
  }
  return problems;
}
