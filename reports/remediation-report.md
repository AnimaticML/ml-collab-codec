# Remediation report

Assignment: `ML_COLLAB_REMEDIATION.md` and `ML_COLLAB_REMEDIATION_ACCEPTANCE.md` (baseline
`73a782d`). Contracts are recorded in `SPEC.md` §19; consumer detail is in `docs/`. Every
finding was first reproduced on the baseline (11/11 historical probes failed there, plus
reproductions of the other findings), then repaired with tests that assert the required
outcome from the specification or an independent oracle.

## F01–F18 dispositions

| Key | Disposition                                                                                                                                                                                                                                                                                                                         | Evidence                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| F01 | **Fixed.** One recursive normalization (items, nested objects, arrays of objects; unknown keys per `additionalProperties` at every depth; bounded depth, cycles, hostile keys) shared by parse, JSON import, validation, provider decode, and the authority. Structural and assertion diagnostics are both reported at exact paths. | MR02, MR04, MR05, MR07, C03                                              |
| F02 | **Fixed.** `validateDocument`/`validateTable` check types and constraints at every depth, required properties, content modes, allowed tags and nesting, stable identity, duplicate ids, unique definitions, and references.                                                                                                         | MR02, MR03, MR06, MR09                                                   |
| F03 | **Fixed.** `Authority.create(..., { schema })` validates the initial state and every final candidate (`schemaValidator`, incremental, differential-tested against full validation); intermediate states may be invalid, final ones never publish.                                                                                   | MR03, MR06; fault `schema-constraint-omission`                           |
| F04 | **Fixed.** Standard JSON Schema 2020-12 manifests (`defineDocumentSchema`) with `x-additive`, `x-reference`, `x-encoding`; the compact profile is an import format (`migrateLegacySchema`); examples and built-package consumers use manifests.                                                                                     | MR01, docs/schemas.md                                                    |
| F05 | **Fixed.** Printing is lossless for known components' extra props and unknown opaque components (every JSON kind); values JSON cannot carry are refused before save.                                                                                                                                                                | MR05, MR08, C07, C11                                                     |
| F06 | **Fixed.** Same-id type changes diff to `setTag` (a new, invertible, transformable primitive); `$root` carries `rootId` through table, operations, source, JSON, checkpoints; a differing root id is refused.                                                                                                                       | MR10, MR11                                                               |
| F07 | **Improved and documented.** Per-field prop diff, positional array splices, identity-keyed LCS child alignment, multi-hunk text diff; coarse boundaries (positional anonymous identity, LCS budget) are documented and tested; no optimality claim.                                                                                 | MR12, MR13, docs/agents.md                                               |
| F08 | **Fixed.** `exportComponentProperties` vs `exportDocument` (`nativeTree`, typed `rowProjection` admitting text rows), paired encoder/decoder, measured depth/properties/variants against budgets, enforcement claims backed by emitted keywords.                                                                                    | MR14–MR17, S01–S08                                                       |
| F09 | **Fixed.** Dated, sourced profiles with `documented`/`internal` budget labels; independent offline grammar validation (Ajv); opt-in `bun run probe:live`; default tests identical with or without credential variables. Live probes were not run (no credentials used).                                                             | MR16, MR18                                                               |
| F10 | **Fixed (contract).** Acquisition copies; deeply `readonly` public types; frozen rows; frozen sent envelopes; `editableCopy` for free edits. Runtime deep freezing is not provided (explicitly not mandatory); writes through casts are outside the contract (probe I1 records it as an observation).                               | MR19–MR21, adapted probes I1–I3                                          |
| F11 | **Fixed.** Async completion invalidates dependents, schedules a flush, notifies listeners; failure/retry; generation checks discard stale, removed, redefined, or superseded results.                                                                                                                                               | MR22–MR24; fault `stale-async-result`                                    |
| F12 | **Fixed where it mattered; costs measured.** Reverse indexes for node-wide invalidation and projection re-resolution; restricted events forward original records when visibility is unchanged (projection diff only for reveals/hides). Remaining full scans are listed in the benchmark report.                                    | MR24, MR31, reports/benchmarks.md                                        |
| F13 | **Fixed.** Promise-based `DurableStore`; serialized host; durable-before-publish; stale/unknown outcomes reload; owner fencing on every step; checkpoints never replaced by older cuts; strict, bounded checkpoint import.                                                                                                          | MR32, MR39, MR40; faults `premature-publication`, `wrong-checkpoint-cut` |
| F14 | **Fixed.** Bootstrap snapshots (state, handles, scope), `beginJoin` fence, `bootstrapFromCheckpoint`, `joinClient` with tail integration, gaps, duplicates, and restricted projections; transport-neutral.                                                                                                                          | MR25–MR28, MR33; fault `snapshot-tail-gap`                               |
| F15 | **Fixed.** `getStatus().history` is `empty`, `restored`, or `unavailable`; sessions carry actor and schema; restore in the session's own context (reconstructed from self-contained records) or explicit unavailability with retained intent; `SessionStore` port.                                                                  | MR29–MR31; fault `lost-history-on-restart`                               |
| F16 | **Fixed.** 13×13 pair matrix (10,658 cases, both precedences, spec-derived oracle and identity sequence model); generator outcomes fully classified; simulator with validators, checkpoints, joins, restarts; 15 real-source faults all killed.                                                                                     | MR34–MR38, reports/ot-pair-coverage.md, reports/mutation-report.md       |
| F17 | **Fixed.** Documented pinned-checkout recipe tested from a clean clone with a separate Node/Bun consumer and a declarations-only TypeScript consumer; `engines.node` is `>=20.11` (the tested runtime).                                                                                                                             | MR41, docs/installation.md                                               |
| F18 | **Fixed.** Nine guides with executed programs; README rewritten; SPEC §17 updated and §19 added; stale names checked absent; benchmark report states environment, method, and what is measured.                                                                                                                                     | MR42, MR43, MR44                                                         |

Defects found and fixed while building the new tests (beyond the register): duplicate
`x-reference` definitions were accepted; the serializer printed `NaN` as `null`; OpenAI
nullable type arrays were not counted toward measured depth; comma encoding rejected
`$ref`'d primitive items; one structural diagnostic suppressed all assertion diagnostics;
identity retags created empty revisions; the benchmark script used a retired format.

## Acceptance mapping

`ACCEPTANCE.md` maps each MR family to its test file; each family has at least one literal
`MRxx` test with substantive assertions (the inventory guard checks the names, the tests
check behavior).

| Families  | File                                       | Families  | File                                       |
| --------- | ------------------------------------------ | --------- | ------------------------------------------ |
| MR01–MR07 | `tests/acceptance/mr-schema.test.ts`       | MR25–MR28 | `tests/acceptance/mr-join.test.ts`         |
| MR08–MR10 | `tests/acceptance/mr-codec.test.ts`        | MR29–MR31 | `tests/acceptance/mr-history.test.ts`      |
| MR11–MR13 | `tests/acceptance/mr-diff.test.ts`         | MR32–MR33 | `tests/acceptance/mr-checkpoint.test.ts`   |
| MR14–MR18 | `tests/acceptance/mr-provider.test.ts`     | MR34–MR35 | `tests/acceptance/mr-ot-pairs.test.ts`     |
| MR19–MR21 | `tests/acceptance/mr-ownership.test.ts`    | MR36      | `tests/acceptance/mr-ot-generated.test.ts` |
| MR22–MR24 | `tests/acceptance/mr-runtime.test.ts`      | MR37      | `tests/acceptance/mr-ot-histories.test.ts` |
| MR39–MR40 | `tests/acceptance/mr-host.test.ts`         | MR38      | `tests/acceptance/mr-mutation.test.ts`     |
| MR41      | `tests/acceptance/mr-distribution.test.ts` | MR42–MR44 | `tests/acceptance/mr-delivery.test.ts`     |

## Historical probes

`review-evidence/ml-collab-codec-review-probes.mjs` is unchanged. Against the current build
it reports 7 passed and 4 failed: V4 and P1 call removed APIs (`schemaInvariants`,
`exportNodeTableSchema`/`PROVIDER_CAPABILITIES`), and I1/I2 require blocking deliberate
writes through borrowed arrays, which the owner's policy does not require. The ported copy
(`tests/fixtures/review-probes-adapted.mjs`, changes listed in its header) passes 11/11 in
MR44 and records the unguarded cast write as an observation.

## Commands and results (2026-09-27)

Environment: Bun 1.2.5, Node 20.11.0, TypeScript 5.9.3, Linux x64.

| Command                    | Result                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`            | exit 0; 187 tests across 44 files; 158 scenario IDs (60 baseline, 54 revision, 44 remediation) with active tests                       |
| `bun run test:property`    | exit 0; 17 tests; algebra 20,000 seeds ×2 sweeps, 1,000 histories × 120 steps, 2,000 diff-law and 5,000 differential seeds; 1 min 13 s |
| `bun run ot:report`        | 10,658 pair cases, 169 cells, 0 failures; generated sweeps 3,000 + 3,000 seeds, 0 failures                                             |
| `bun run test:mutation`    | 15 faults, 0 survived (killing tests listed per fault)                                                                                 |
| `bun run bench`            | medians/p95 recorded in `reports/benchmarks.md`; every measured admission applied                                                      |
| `bun run probe:live`       | not run with credentials: every provider reports `skipped` (opt-in); no live evidence is claimed                                       |
| Historical probes (orig.)  | 7 passed, 4 failed (API renames and the non-mandatory deep-freeze expectation; see above)                                              |
| Historical probes (ported) | 11 passed, 0 failed                                                                                                                    |

Seed budgets are reproducible (`PROPERTY_SEED_START`, per-suite `PROPERTY_BUDGET_*`). These
runs are evidence of what was exercised, not a proof of the transform algebra.
