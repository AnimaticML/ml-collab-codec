# Verification and performance

## Commands

| Command                           | What it runs                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                   | Prettier, `tsc` (strict), ESLint (size limits), Knip (dead code), build, all tests, ID inventory, core types without DOM/Node/Bun |
| `bun run test`                    | every test file under `tests/`                                                                                                    |
| `bun run test:property`           | the larger seeded budgets (algebra 20,000, histories 1,000 × 120 steps, schema differential 5,000)                                |
| `bun run test:mutation`           | the full acceptance suite once per controlled fault → `reports/mutation-report.md`                                                |
| `bun run ot:report`               | pair-matrix and generator counts → `reports/ot-pair-coverage.md`                                                                  |
| `bun run bench`                   | benchmarks → `reports/benchmarks.md`                                                                                              |
| `PROBE_LIVE=1 bun run probe:live` | opt-in live provider probes (needs credentials; prints status lines only)                                                         |

Seed budgets are per suite (`PROPERTY_BUDGET_ALGEBRA`, `PROPERTY_BUDGET_HISTORY`,
`PROPERTY_BUDGET_SCHEMA`, or the shared `PROPERTY_BUDGET`; `PROPERTY_SEED_START`,
`PROPERTY_STEPS`); a configured budget only raises a suite's default. Minimized
counterexamples stay pinned as regressions with their seed and explanation.

## Test families

`ACCEPTANCE.md` maps every scenario ID (baseline C/S/I/O/P/V/Q, the OT revision R01–R54, and
the remediation MR01–MR44, and the causal own-undo repair MR45–MR46) to the files with its assertions. Highlights:

- **Operation algebra**: every ordered pair of the 13 primitive kinds at boundary geometries,
  in both origin precedences, checked against an independent oracle (a spec-derived
  conflict predicate and an identity model of sequences), plus TP1, both branch inverse
  laws, serialization, argument order, and input isolation; generated composite changes on
  random and dense documents with every outcome classified.
- **Histories**: simulated authorities with 3–5 clients, reordered and duplicated delivery,
  rejections by validators, undo/redo, restarts from sessions, checkpoint restarts with
  pruning, and mid-run joins; every intermediate view is checked.
- **Fault injection**: 15 faults patched into the real source (equal-value delete search,
  wrong boundary affinity, off-by-one mapping, lost inner insertion, stale inverse payload,
  swallowed conflict, reject-all transform, duplicate delta, failure swallowing, wrong
  checkpoint cut, premature publication, stale async result, snapshot-tail gap, lost
  history on restart, schema constraint omission); each must be killed by an assertion.
- **Distribution**: a clean clone of the current commit is built and consumed by a separate
  package on Node and Bun and by a declarations-only TypeScript consumer.
- **Docs**: every `ts` block in `README.md` and `docs/` runs as a program.

Finite seeded runs and fault lists are evidence of what was exercised, not a proof.

## Performance

`reports/benchmarks.md` records medians and p95s on Word-like documents of 30–500 pages
with schema validation, history, and copy-on-acquisition enabled. On the recorded
machine, keystrokes and their admission stay well under a millisecond at every size;
paragraph inserts and moves on a 10,000-child root cost a few milliseconds; parse,
serialize, `toTable`, full validation, and whole-document proposals are linear full scans
(hundreds of milliseconds at 500 pages). A text run is one string, so typing inside a very
long run (hundreds of thousands of characters) costs time linear in that run. Numbers are
for that environment only.

## Known limits

- One authority per document (scalar-prefix profile); no multi-writer or offline-merge mode.
- Anonymous siblings have positional identity in diffs; very long child lists fall back to a
  coarse middle replacement in `diffToChanges`.
- Restricted participants receive projected diffs on reveal or hide; anonymous content that
  is newly revealed gets participant-local handles.
- Provider profiles are dated documentation evidence; live probes are opt-in and have not
  been run in this repository.
- Nested props and child arrays of rows are not frozen at runtime; mutating borrowed views
  through casts is outside the contract.
