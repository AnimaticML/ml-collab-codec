/**
 * Controlled faults for mutation checks (MR38). Each patches one real
 * source site (an exact, unique snippet) at module-load time; the named
 * suites must fail against the patched implementation. A snippet that no
 * longer matches exactly once aborts the run, so a refactor cannot turn a
 * fault into a silent no-op.
 */
interface Fault {
  readonly id: string;
  readonly description: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  /** Test files expected to catch the fault. */
  readonly killers: readonly string[];
}

export const FAULTS: readonly Fault[] = [
  {
    id: "equal-value-delete",
    description: "array deletion searches for an equal value instead of using its occurrence index",
    file: "src/core/apply.ts",
    find: "const removed = array.splice(change.index, change.values.length);",
    replace:
      "const found = array.findIndex((v) => deepEqual(v, change.values[0] as JsonValue));\n    const removed = array.splice(found < 0 ? change.index : found, change.values.length);",
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "boundary-affinity",
    description: "text inserted at a split point moves to the right-hand run",
    file: "src/core/transform-text.ts",
    find: "relocate(a.node, a.offset, b, true)",
    replace: "relocate(a.node, a.offset, b, false)",
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "offset-off-by-one",
    description: "a gap after a concurrent deletion is mapped one position too far",
    file: "src/core/seq.ts",
    find: "return gap >= step.index + step.count ? gap - step.count : step.index;",
    replace: "return gap >= step.index + step.count ? gap - step.count + 1 : step.index;",
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "lost-inner-insertion",
    description: "an insertion inside a concurrently deleted range is dropped",
    file: "src/core/transform-text.ts",
    find: "if (step !== null) return [{ ...a, offset: mapGap(a.offset, step, originTie(a.origin, a.text)) }];",
    replace:
      'if (step !== null && step.t === "del" && a.offset > step.index && a.offset < step.index + step.count) return [];\n  if (step !== null) return [{ ...a, offset: mapGap(a.offset, step, originTie(a.origin, a.text)) }];',
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "stale-inverse-payload",
    description: "the inverse of a text deletion restores a truncated payload",
    file: "src/core/change.ts",
    find: 'return { ...change, kind: "textInsert" };',
    replace: 'return { ...change, kind: "textInsert", text: change.text.slice(1) };',
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "swallowed-conflict",
    description: "concurrent writes of different values to one field merge last-writer-wins",
    file: "src/core/transform-props.ts",
    find: 'return conflict("concurrentWrite", "concurrent writes to the same field");',
    replace: "return [a];",
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "reject-all-transform",
    description: "every concurrent pair is reported as a conflict",
    file: "src/core/transform.ts",
    find: "if (a.length === 0 || b.length === 0) return { a, b };",
    replace: 'return { conflict: "concurrentWrite", detail: "reject all" };',
    killers: ["tests/acceptance/mr-ot-pairs.test.ts"],
  },
  {
    id: "duplicate-delta",
    description: "a retried request is decided again instead of returning its receipt",
    file: "src/core/authority.ts",
    find: 'if (found.kind === "found") {',
    replace: 'if (found.kind === "found" && found.record.fingerprint === "never") {',
    killers: ["tests/acceptance/mr-host.test.ts"],
  },
  {
    id: "failure-swallowing",
    description: "a candidate that fails to apply is admitted as a no-op",
    file: "src/core/authority-evaluate.ts",
    find: "if (error instanceof ApplyError) return `invalid: ${error.code}`;",
    replace: "if (error instanceof ApplyError) return { changes: [], candidate: ctx.table };",
    killers: ["tests/acceptance/mr-checkpoint.test.ts"],
  },
  {
    id: "wrong-checkpoint-cut",
    description: "a checkpoint cut is taken one record past the durable position",
    file: "src/core/host.ts",
    find: "const cut = this.position;",
    replace: "const cut = this.position + 1;",
    killers: ["tests/acceptance/mr-host.test.ts"],
  },
  {
    id: "premature-publication",
    description: "a decision is installed before its durable append",
    file: "src/core/host.ts",
    find: "const result = await this.store.append(this.position, this.owner, record);",
    replace:
      "this.current.install(prepared);\n        const result = await this.store.append(this.position, this.owner, record);",
    killers: ["tests/acceptance/mr-host.test.ts"],
  },
  {
    id: "stale-async-result",
    description: "an async result for superseded inputs is installed",
    file: "src/runtime/derived.ts",
    find: "if (this.entries.get(key) !== entry || entry.dirty) return;",
    replace: "if (this.entries.get(key) !== entry) return;",
    killers: ["tests/acceptance/mr-runtime.test.ts"],
  },
  {
    id: "snapshot-tail-gap",
    description: "the first transition after the snapshot is skipped during join",
    file: "src/core/join.ts",
    find: "transition.revision > client.state.revision",
    replace: "transition.revision > client.state.revision + 1",
    killers: ["tests/acceptance/mr-history.test.ts"],
  },
  {
    id: "lost-history-on-restart",
    description: "exported sessions drop their undo groups",
    file: "src/core/client-session.ts",
    find: "      history,",
    replace: "      history: { ...history, groups: [] },",
    killers: ["tests/acceptance/mr-history.test.ts"],
  },
  {
    id: "schema-constraint-omission",
    description: "final-candidate validation ignores the rows the changes touched",
    file: "src/core/invariants.ts",
    find: "const issues = incrementalIssues(profile, before, candidate, changes);",
    replace: "const issues = incrementalIssues(profile, before, candidate, []);",
    killers: ["tests/acceptance/mr-schema.test.ts"],
  },
];
