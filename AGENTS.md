# Agent instructions

## Deliverable and authority

Build the reusable library described in `SPEC.md`. This is an implementation task,
not a request for another architecture proposal. All repository-facing prose,
identifiers, diagnostics, tests, and comments should be English; multilingual text
fixtures are intentional.

Authority order: latest explicit owner instruction, the OT revision v3 handoff
(`OT_REVISION_HANDOFF.md`, `OT_REVISION_ACCEPTANCE.md`), `SPEC.md`, acceptance
outcomes, then implementation choices. `REFERENCES.md` records the source handoffs
and their superseded clauses. External libraries are references, not product
requirements. SPEC §18 records the implemented v3 decisions; keep it current.

Revision v3 fixes the collaboration model: one logical authority per document with a
scalar confirmed prefix, paired inclusion transformation, forward rebasing with
private recovery, replica-scoped request identity with stable effect origins, and
self-contained reversible records. Collaborative undo/redo of own groups is required;
it is never an old inverse or a snapshot diff. Keep request identity, causal context,
deterministic insertion ordering, and authoritative admission distinct. Do not add a
vector-clock/multi-writer profile, consensus, or a production deployment system.

The owner accepted the preceding v1 proposal except for preserving optional/null
presence distinctions in agent output. Do not reintroduce tagged presence unions,
tri-state agent values, or lexical-presence operations. Default application-facing
normalization uses one effective value for equivalent optional/default spellings.
Do not accidentally collapse `false`, `0`, or an empty string with null.

Do not depend on access to old chats. Do not require private Docong files, the
AnimaticML fork, a production server, or API keys to make progress on the core.
When an optional reference is unavailable, record that limitation and continue.

## First session

1. Inspect the working tree and existing instructions. Preserve unrelated changes.
2. Install with Bun, commit the real lockfile, and make the scaffold tools run.
3. Read the pinned old code and tests in REFERENCES. Record keep/change decisions
   in SPEC's legacy section. Do not copy old bugs into the new implementation.
4. Resolve delegated decisions in SPEC's decision table with short reasons and
   acceptance examples. Technical decisions are delegated: choose, test, proceed;
   do not ask the owner to approve every internal type or package.
5. Start the first failing codec/normalization tests and implement a vertical slice.

Choose the smallest coherent design that can pass the required rich-text, numeric,
invariant, and hidden-region scenarios. Do not silently replace OT with whole-node
last-writer-wins, locks, CRDTs, or rejection of every stale write. A separately named
optimistic-concurrency mode is permitted, but is not completion of the OT goal.

## Test-driven work loop

For each increment:

- Select a small group of acceptance IDs and write actual failing assertions first.
- Implement the minimum coherent behavior, including error cases and diagnostics.
- Run focused tests, then `bun run check:dev`; inspect failures rather than hiding them.
- Remove superseded code, temporary adapters, unused exports, and dependencies.
- Update the relevant SPEC decision or known limitation when needed, then continue.

Keep passing prior cases. Convert minimized property-test failures to regression
fixtures with a seed and explanation. Expected states come from SPEC, not snapshots
blindly regenerated from the implementation. Never weaken an outcome solely to make
CI green. A genuine ambiguity should be resolved explicitly in SPEC before coding
that behavior; do not manufacture a domain requirement absent from the handoff.

Use real public API integration tests in addition to unit tests. Test imports of the
built package and types. A mock OT engine, hard-coded demo transcript, or broad
conflict fallback does not satisfy the behavioral scenarios.

## Quality baseline

TypeScript with strict checking and Bun as the development/test runner. The clean
core has no filesystem, network, process, DOM, Node, or Bun runtime requirement.
Runtime facilities live in adapters/tooling and are passed in explicitly when needed.

Starting limits, configured in ESLint:

| Area                             | Maximum nonblank, noncomment lines per file |
| -------------------------------- | ------------------------------------------: |
| Production TypeScript            |                                         300 |
| Test, example, and tooling files |                                         450 |

Production/tooling functions start with an 80-line limit. Split by responsibility,
not arbitrary numbered fragments; test `describe` wrappers are exempt from the
function limit. These are engineering defaults chosen for this handoff, not numbers
previously dictated by the owner. Change them only with an explicit narrow reason,
not by disabling the rule globally or minifying code onto fewer lines.

ESLint and TypeScript detect local issues; Knip checks unused files, exports, and
dependencies. Do not mark all source files as entry points, add blanket ignores,
export dead helpers from the public index, or disable a gate to keep dead code.
Knip includes entry-file exports too. Keep public exports intentional and exercised by consumer tests. Any necessary
exception must be local and explained. Static analysis is not proof of reachability
through every plugin path; review registered runtime hooks deliberately.

No `any` as an escape hatch, broad `@ts-ignore`, empty catch blocks, silent recovery,
placeholder returns, speculative generic frameworks, or commented-out alternative
implementations. Do not add wrappers or dependencies before they are used. Prettier
handles layout; avoid style debates and duplicate formatting rules.

`clean` only removes generated outputs. Never clean source fixtures, source documents,
lockfiles, user files, or unrelated working-tree changes. Do not use destructive git
commands as a shortcut to a clean report.

## Acceptance test layout

`ACCEPTANCE.md` lists 60 baseline IDs, the 54 revision families R01–R54, and the
remediation families MR01–MR44 (`ML_COLLAB_REMEDIATION_ACCEPTANCE.md`). Each ID has at
least one real `test("C01 ...", () => { ... })`-style case using its literal ID prefix;
the inventory guard recognizes all three. Keep the IDs. More tests for one ID
are welcome. P06 now requires working collaborative undo.
Use loops/parameterization inside that named case when appropriate. Add new scenarios
to ACCEPTANCE before assigning new baseline IDs.

The completion guard requires literal named cases and rejects `.todo`, `.skip`, and
`.only` in this directory. It is a small inventory check, not a testing framework and
not a proof of meaningful assertions. Do not game it with an empty callback or a
comment containing a fake test declaration. Required provider-baseline tests are
local deterministic tests; optional paid/live calls are a separate suite with
explicit environment-based skips.

Seeded property tests (transform TP1/inversion, diff law) and a simulated
authoritative server with three clients, pending queues, duplicate and reordered
delivery, rejection, undo/redo, and reconnect run with fixed small seeds in normal CI;
`bun run test:property` runs the larger reproducible budget (`PROPERTY_BUDGET`,
`PROPERTY_SEED_START`, `PROPERTY_STEPS`). Keep minimized counterexamples as pinned
regressions with their seed and explanation.

## Implementation order

A. Codec, normalization, schema profile, diagnostics, and local-file round-trip.
B. IDs, addressing, atomic application, identity-aware diff, and value/delta rules.
C. Structural/text OT and its client/server protocol, including rich-text reshaping.
D. Provider schema export/projections and optional live probes.
E. Restricted visibility through homogeneous regions and an authoritative action.
F. Runnable examples, actual runtime/package checks, hardening, and cleanup.
G. OT revision v3 (done; see SPEC §18): reversible records, identity/context/origin
contract, publication boundary, runtime adapters, grouping/coalescing, collaborative
undo/redo, anchors/proposals, checkpoints/host contract, and R01–R54 evidence.
H. Remediation (done; see SPEC §19): standard JSON Schema contract, lossless codec,
identity-aware diff, honest provider exports, snapshot join and session restore, strict
checkpoints, async host, async derived propagation, pair-matrix/generator/simulation/
fault-injection OT evidence, pinned-Git consumption, and executed consumer docs.

These are milestones, not permission to stop at A or B. Work through required scope.
Steps may overlap where dependencies make that more efficient. Do not finish with
only README/SPEC changes or claim the first two-client demo proves full correctness.

## Delivery

The final repository must include working source, tests, README/API usage, updated
SPEC decisions, reproducible commands, synthetic fixtures, and runnable headless
examples for rich text, numeric board edits, and a hidden-hand game. No polished UI
is required. A minimal trusted HTML bootstrap is part of the container example, not
a generic renderer framework.

Run `bun run check` from a clean dependency install. Integrate package/runtime checks
into it when implemented. Run the larger property budget separately. Report exact
commands, exit results, scenario coverage, runtime versions, known limitations, and
provider live-probe status. Coverage percentages and fuzz seeds are evidence, not
universal mathematical claims. Keep unavailable live tests visibly skipped.

Before declaring completion: no baseline TODO/skip/focus, no fake source entry, no
unused implementation branch, no unreviewed suppressions, no missing required demo,
and no dependency on server/history for local file opening. The owner selected
Apache-2.0 and a public GitHub repository; npm publishing (removing `"private": true`)
still needs a separate owner decision. Do not push to
an unspecified remote, publish a package, or modify the legacy reference repository.
