# ml-collab-codec: post-review remediation and consumer-readiness handoff

**Assignment date:** 2026-09-26  
**Repository:** `AnimaticML/ml-collab-codec`  
**Reviewed baseline:** `73a782d17961b086d6e05a2fb65a3e0bf288f231`  
**Implementation environment:** TypeScript, Bun; retain portable core and the existing quality gates.  
**Companion:** `ML_COLLAB_REMEDIATION_ACCEPTANCE.md`

## 1. Purpose, precedence, and evidence

Repair the existing library so it can become a reliable dependency of the owner's real applications. Do not start again, build a hypothetical application platform, or treat the earlier green scenario inventory as proof that the public contracts are complete.

This handoff consolidates **all findings of the source review**, plus the owner's subsequent questions about snapshot-based joining, undo before a snapshot, systematic OT test coverage, and pragmatic data ownership. It is the complete corrective assignment; the accompanying 11-probe script is only a small piece of historical review evidence.

Precedence: newer explicit owner instructions; this handoff and its acceptance outcomes; the existing product specification and v3 protocol decisions where not changed here; implementation comments. Reconcile `SPEC.md`, `ACCEPTANCE.md`, `AGENTS.md`, README, and examples instead of accumulating contradictory exception paragraphs. Do not reinterpret every past design option as simultaneously required.

The baseline branch was rechecked on 2026-09-26 and still pointed to the SHA above. The preceding review read source and a successful GitHub Actions run reporting 143 tests across 28 files and 114 scenario IDs. In preparing this handoff, checkpoint, restoration, join-fixture, generator, and algebra-test sources were inspected again. **The reviewer did not execute the repository suite or the 11 probes:** Bun was absent and a container clone failed at DNS resolution. Statements below marked as findings are source-derived observations to reproduce, not invented execution results. Existing repository tests are evidence of the cases they actually assert, not independent proof of the entire API.

At implementation start, record the actual commit. Reproduce each issue on that commit, or identify the commit/test that already fixes it. Source location names below refer to the reviewed baseline and may move during repairs.

## 2. Preserve the accepted architecture and exclusions

Retain the following unless a repair demonstrably requires a narrowly documented change:

- Readable tagged source and equivalent JSON; mixed content; own portable parser, not browser DOM parsing.
- A standard, portable schema contract with document annotations; an internal compiled descriptor is allowed, but is not a replacement public schema language.
- Optional omission/null/explicit-default equivalence at the application-value layer; no `{present, value}` protocol. Preserve meaningful zero, false, empty string, order, identity, and whitespace. Invalid values are diagnostics, not silent repairs.
- Persistent IDs at selected structural boundaries; internal handles for anonymous nodes/text; occurrence-based sequence addressing, not deep-value search.
- The selected scalar-prefix control profile: one logical authority per document/history, stable client request identity, paired forward rebase, one in-flight request plus dependent unsent work, recovery when needed. Do not replace this with a vector-clock or multi-writer project.
- Self-contained reversible accepted records; transform and composition preserve inverse data. Grouped own undo/redo, retained intent, anchors, and base-aware proposals.
- Coherent publication after a complete update; application-controlled scheduling of derived computations.
- Existing homogeneous-region access checks and safe handling of historical/removed values.

**Not required:** npm publication, production deployments, a chosen database, Cloudflare/Cloud Run/VPS adapters, actual WebSockets/authentication service, MCP server, CodeMirror/ProseMirror integration, DOM/canvas renderer, encryption, or new UI. Library CI remains the library's responsibility. Implement transport/storage-neutral contracts and test doubles where required here, not multiple speculative deployments.

## 3. Findings and disposition register

This register prevents the small probe file from becoming an accidentally narrowed scope. Turn each row into actual tests and implementation/documentation evidence.

| Key | Source-derived observation at the baseline | Required disposition |
|---|---|---|
| F01 | `normalize.ts` checks array container type, not recursively every item; nested unknown keys can disappear. | One recursive, lossless validation/normalization policy across entry points. |
| F02 | `validate.ts` mainly checks duplicate IDs, references, and some array minima; its name/docs imply more. | Real document validation, including types, required properties, content modes, tags, identity, nesting, and references. |
| F03 | `schemaInvariants` checks additive fields and selected top-level minima, not full candidate validity. | Recommended authority setup must enforce the declared schema on the final candidate; changed descendants and global reference effects must not escape it. |
| F04 | `schema.ts` exposes a custom compact dialect, despite the agreed JSON Schema direction. | Standard JSON Schema input plus explicit annotations/manifest; migrate examples and provide compatibility guidance. |
| F05 | `serializer.ts` emits only declared properties of known components; opaque preservation is incomplete. | Accepted opaque values survive every supported round-trip; unsupported input is rejected before loss. |
| F06 | `diff.ts` can reuse an ID with a new tag without updating the tag; root ID is lost through `$root` conversion. | Correct type-change diff and preservation of accepted root identity. |
| F07 | Whole-object/array diff is coarse; anonymous mixed-content changes can trigger large replacement. | Improve common independent-property/list cases and precisely document fallback conflict scope; no claim of optimal tree differencing. |
| F08 | `providers.ts` native route exports component properties, not recursive document content; projected props are untyped; the emitted tag enum excludes the text rows its decoder expects; depth checking is not implemented. | Real typed document routes, correct paired decode, measured limits and trustworthy enforcement reports. |
| F09 | Provider capabilities are dated placeholders; tests do not exercise live schemas; S01 assumes no API key exists. | Evidence-based provider profiles, independent offline grammar tests, opt-in live probes, environment-independent default tests. |
| F10 | Rows are shallow-frozen but expose unfrozen children and shared props; `JsonValue[]` is mutable in types. | Explicit ownership/read-only contract and isolation under supported use; runtime deep freezing is not mandatory. |
| F11 | Async derived completion updates a cache without invalidating downstream consumers. | Completion participates in dependency invalidation/publication; stale/replaced jobs cannot publish. |
| F12 | Projection re-resolves every instance, region views use full diff, and some dependency invalidation scans all entries. | Establish truthful costs; fix incorrect invalidation; optimize only measured consumer-relevant paths. |
| F13 | `DurableStore`/`AuthorityHost` are synchronous; checkpoint import validates only parts of its structure. | A usable async-capable hosting boundary and strict, bounded checkpoint import; preserve durable-before-publish and owner fencing. |
| F14 | `Client(table, revision)`, checkpoint restore, and tail delivery exist, but join is a same-process fixture, not a complete documented safe bootstrap contract. | Complete the snapshot+tail+live handoff and expose/test it without implementing production transport. |
| F15 | Undo survives pruning only with separately saved client cancellation handles; a newly constructed client starts without them. | Explicit history availability and context-safe restoration; do not imply a snapshot contains old undo actions. |
| F16 | OT generators are meaningful but lack a demonstrated operation-pair/geometry inventory; some failures/conflicts are skipped. | Systematic pair coverage and exact admissibility expectations in addition to generated protocol histories. |
| F17 | Git package exports point to absent-on-checkout `dist`; no install-time build is configured; Node declarations and tested versions differ. | Supported pinned-Git consumption path tested from a clean consumer; no registry publication requirement. |
| F18 | Docs mix requirements with stale implementation claims; benchmark labels can be mistaken for full application cost. | Consumer docs with executable snippets, accurate scope/performance/verification statements and no stale operation names. |

Primary baseline locations: `src/core/{schema,normalize,validate,invariants,build,parser,serializer,table,persistent-table,staging,diff,providers,provider-decode,change,transform,client,history,checkpoint,host,visibility,store}.ts`; `src/runtime/{derived,projection,selector}.ts`; `tests/support/{gen,random,room}.ts`; `tests/unit/transform-properties.test.ts`; `tests/acceptance/{s,r-control,r-simulation}.test.ts`; `package.json`, `scripts/bench.ts`.

## 4. Schema and validation: one trustworthy contract

### 4.1 Public schema

Make the portable authoring/validation representation a documented subset of JSON Schema 2020-12. A component registry or manifest may add tag mapping, identity, content roles, reference roles, numeric-delta capability, encoding hints, and regions. Property types, required properties, arrays, nested objects, and supported constraints use standard JSON Schema meanings. Do not require authors to maintain two schemas independently.

Use or compile to an established portable validator where appropriate. Writing another generic validator is not a goal. An internal optimized descriptor is fine. Provide a migration function/example for existing `SchemaProfile` fixtures so applications do not silently switch interpretation. Optional Zod authoring is an adapter to this contract, not permission to accept arbitrary transforms as portable schemas.

The initial supported set must cover existing use cases and typed document/provider representation: objects, arrays, primitives and integers, ordinary `properties`/`required`/`items`/`additionalProperties`, declared length/numeric bounds, enums/constants, local definitions/references, and the variants needed for typed node kinds and mixed content. Record precise exclusions. Unsupported assertions or annotation combinations must produce capability diagnostics rather than silently become `any`. Local recursive references need not involve network schema loading. Explicit schema versions identify interpretation.

### 4.2 Decode, normalize, then validate without data loss

Keep syntax decoding and the owner's effective-value normalization explicit. Source attributes may decode according to the schema; optional null/omission/default equivalence is library semantics, not a claim that standard JSON Schema inserts defaults. The final effective value must satisfy its standard validation schema. Validation alone must not mutate its input.

Recursively validate array members and object properties, including inside array members. Unknown properties are either rejected with a precise path or preserved under the declared opaque policy. Never delete unknown nested data while reporting successful validation. Check defaults against their complete declared constraints at registration. Handle genuine required fields explicitly; do not use a default to hide a missing genuinely required field.

### 4.3 All entry paths enforce the same effective contract

Cover source parse, raw JSON import, standalone `validateDocument`, provider decode, proposed free edits, authority final candidates, and restored snapshots/checkpoints. A deliberately low-level structural `applyChanges` may remain schema-independent, but must be documented as such. The recommended schema-backed application/authority entry point cannot accept schema-invalid data.

Validate final transactions atomically. Intermediate stages may temporarily violate domain constraints. Final validation includes newly inserted descendants, changed parent/child relationships, nested constraints, removed definitions, and affected references outside the locally edited node. Optimized validation must be differential-tested against a full reference validation of the final state. Do not let a client-supplied flag or constraint weaken the trusted schema.

## 5. Codec, diff, and free-agent-edit correctness

Preserve every accepted effective datum in `parse(print(model))`, including opaque extension payloads, mixed text, root/node identity, schema metadata in the declared envelope, ordering and JSON values of all supported types. Unknown opaque components need a real representation for structured values/JSON blocks, not string-only serialization. A strict mode can reject unknown input; an explicit preserve mode must actually preserve it.

Review multi-root entry points: a mode promising all roots cannot quietly return only the first; root/document/fragment APIs must have truthful return types and diagnostics. Preserve exact source data on failure. Browser bootstrap remains an envelope for the original source, not DOM-based parsing or a requirement that the dialect obey all HTML rules.

For any valid supported A and B, require effective equality of `apply(A, diff(A,B))` and B. Same-ID tag changes (for example paragraph to heading), root metadata, moves between wrappers, mixed-content restructurings, and permitted opaque data must be included. Implement same-ID type changes with explicit generic structural semantics; do not falsely return success without the change or silently regenerate IDs to evade the problem. Concurrent compatibility or conflict for such changes must be specified and tested.

Diff should descend into independently editable nested object fields and cover common list edits without replacing unrelated data unnecessarily. Persisted identity is stronger evidence than similarity; do not infer identity from equal duplicate values. A deterministic coarse fallback can remain for genuinely ambiguous anonymous structures, but its scope and conflict implications must be documented. Keep the owner-approved distinction between reconstructing a transition and recovering actual author intent.

A proposal always originates from the retained A/read base: `diff(A,B)` is rebased over A→C. Do not use `diff(C,B)`. Existing `Proposal`, `proposeEdit`, and `rebaseProposal` are real building blocks: retain and test them; do not claim suggestion mode has no engine support. Review UI and moderation of another actor's history remain application policy, not mandatory new UI/features here.

## 6. Structured-output exports are contracts, not labels

Separate **component-property export** from **complete document export** in the API. A method returning only properties must not claim to be a recursive document route. Choose native recursion or a typed, reversible nonrecursive projection for the concrete provider/model/API profile.

Document export and decode must agree on node tags, mixed text, ordering, references, persistent identity versus wire references, and property types for each node variant. No unconstrained `props: {type: "object"}` substitute for the domain schema. Internal text rows, if used, must be allowed and typed by the emitted grammar. Another correct mixed-content wire representation is fine; do not preserve the old probe's exact object path as an artificial API requirement.

Count actual schema depth, property/variant complexity, and supported constructs. Generation-enforced versus post-decode-only constraints must describe the schema actually sent. Do not list a constraint as enforced if export omitted it. Always perform the complete local validation before a model result becomes applicable.

Recheck current official OpenAI, Google and Anthropic documentation for explicitly selected models/API modes. Record retrieval date, source, and whether a number is a documented provider limit or an internal conservative budget. Do not mix tool-call schemas, older Gemini schema formats and strict response formats into one generic provider switch.

Provide independent offline tests: actual emitted schema + an independent schema validator + valid and invalid generated examples + decode/re-encode round-trip. A test of `representation === "native"` is not a recursion test. Add opt-in live probes when credentials are available; absence is reported as skipped/unverified, not asserted as a condition of unit-test success. Never send private documents or make paid calls in default tests. Live acceptance is useful evidence, not a substitute for local semantic tests.

## 7. Ownership: safe supported use, without mandatory deep freeze

The owner explicitly does **not** require `Object.freeze` on every exposed object or a hostile-caller-proof runtime. Performance must not be sacrificed to an unrequested defensive mechanism.

Document the actual ownership contract:

1. Library operations never mutate previously published versions or unchanged shared rows.
2. Exposed views are deeply read-only in TypeScript, including arrays nested in `JsonValue`.
3. A caller may use a documented mutable working copy for free edits without changing its retained base.
4. Mutable input values are either copied on acquisition or transferred under an explicit, well-named ownership API. Ordinary convenience APIs must not unexpectedly acquire mutable aliases. Preserve immutable wire/history records under the same rule.
5. Runtime mutation of a borrowed read-only view can be explicitly outside the supported contract. If so, say that plainly; do not advertise enforced runtime immutability. Optional development guards, protective copies at boundaries, and encapsulated collections are alternatives.

The historical I1/I2/I3 probes test a stronger fully defensive API. They are **diagnostic observations, not unconditional acceptance gates** under this clarification. Adapt them into tests for the selected supported ownership boundary and a separate optional protection mode. Do not remove the underlying version-isolation and independent-editing tests.

Benchmarks must include whichever ownership policy ships. Do not claim a faster protected snapshot by silently dropping its documented guarantees.

## 8. Derived state and publication

Keep the current pure model/publication boundary and small runtime adapters. No universal renderer or reactive framework is requested.

Fix async completion so a result moving from pending to ready invalidates/schedules dependent calculations and notifies interested runtime consumers without creating a document operation. Test chains of dependencies, cancellation/removal, a same-key derivation redefinition, a superseding input version, errors/retries, and asynchronous completion after newer edits. A replaced derivation must not inherit an old callback's result simply because the key exists again.

All computations read coherent published inputs. A batch may contain many primitive writes but expose one final document commit. Several commits can be coalesced by an injected scheduler for expensive layout. An explicit current-value request may force only its dependency closure. External font/viewport inputs invalidate only the relevant derived state. Async freshness must be based on the actual dependency/version contract.

Correctness precedes optimizing class re-linking, region projection, or scans in invalidation. Record their complexity and benchmark the relevant paths. Use change summaries and reverse-dependency indexes where beneficial; do not claim all processing is O(changed nodes) while scanning every object. No mandatory rope, balanced child tree, or new persistent collection implementation unless measured or needed for correctness.

## 9. Snapshot-based joining, catch-up, and history

### 9.1 Four different artifacts

| Artifact | Contents | What it does NOT imply |
|---|---|---|
| Standalone document | Effective source/JSON and its interpretation metadata | No room, event log, or undo history is required. |
| Client bootstrap snapshot at V | Authorized operational state with internal handles, scope/schema/control versions, revision V | Not a list to replay from genesis; not all server receipts or every user's inverse data. |
| Authority checkpoint at V | Full trusted operational state plus configured retained transitions/decision metadata | Retained transitions ending at V are already included in state V. They are not the post-snapshot replay tail. |
| User/session history export at U | Own groups, current-context undo/redo handles, pending original bytes/working forms, revision and ownership metadata | Not automatically a complete document snapshot; not applicable to arbitrary newer state without rebase. |

At the reviewed baseline, `CheckpointBundle.rows` is state at V; `transitions` is optional retained history ending at V; `ledger` is decision/dedup metadata. `exportCheckpoint` retains all transitions by default unless given a bound. A lightweight bootstrap must not accidentally transmit that entire archive. `Client.exportSession()` does not include the confirmed table; store it with a compatible base or reconstruct that exact base using permitted retained context.

### 9.2 Complete the join protocol without implementing a network server

Expose a documented transport-neutral bootstrap contract/helper (names delegated) and executable in-memory/async simulated transport examples:

1. Authenticate/authorize externally; identify document, history epoch, schema version and control profile.
2. Capture a coherent operational snapshot at revision V. It may be the current materialized state, or the latest persisted snapshot plus a retained tail.
3. Establish a lossless handoff to accepted events after V, using a subscription fence/buffer or durable resumable cursor. Do not leave a race between reading a snapshot and starting the live stream.
4. Deliver snapshot V and any transitions V+1…W; integrate each once. Buffer gaps and duplicates using the existing protocol. Catch-up metadata must match that snapshot's state and internal handles.
5. Continue with live transitions after W. Do not replay transitions already included in the snapshot, and do not regenerate anonymous/text IDs by re-parsing pretty source during live join.
6. If the history needed during transfer is pruned, return an explicit retry/resync with a fresh cut while retaining unsent intent. Bounded transfer/pinning or another correct policy is permitted; indefinite retention is not required.

If the server captures its latest current state V, the initial tail may be empty. If it sends a stored older state V, the tail reaches the selected current cut W. Both are supported strategies. Producing a snapshot for one client does not reset other clients, the epoch, request IDs, or undo history.

A new client may edit once it has a coherent known base; the protocol must not mislabel its edits as authored after undelivered events. Tests should cover editing during transfer/catch-up as well as waiting until catch-up finishes. The library supplies correct protocol/data pieces; transport routing, chunking and deployment remain adapters.

### 9.3 Undo before the snapshot: explicit, not magical

A bare snapshot contains the result of old changes, not enough information to reconstruct who did them, their grouping, or their exact inverse. Do not synthesize old history from a diff or similar-looking text.

Required behavior:

- A genuinely new participant without an authorized history payload begins with no historical own undo groups. It can undo its subsequent actions. Report history availability explicitly; do not offer other users' changes as its own stack.
- A returning authorized actor with preserved own handles can undo retained pre-snapshot groups after restart/pruning, without replay from genesis. The saved handles must match the restored confirmed context or be safely rebased to it.
- `restore` at U cannot simply be attached to a snapshot at V≠U. Recover state U plus the relevant tail, or migrate the history/pending state into context V using sufficient retained context. If that context was removed and no current handles remain, report history unavailable, preserve local intent, and explain the retention boundary.
- New-device persistence is an adapter choice: a host may store actor-scoped history exports and supply authorized ones on join. Provide a testable restoration port/example, not a new account service or a compulsory server-side per-user database. A fresh device without stored history has no automatic historic undo guarantee.
- Redo and in-flight identities survive only according to explicit stored-state rules. Never reuse an old replica sequence after losing its allocator. Rejected/expired history has a distinct result from a successful no-op.
- Arbitrary moderation/reversion of another actor's work is not enabled by possessing a snapshot or an inverse. Keep existing policy boundaries; document how an application could add a separately authorized action.

The existing R38 test is useful: it saves a local session, checkpoints/prunes at that same confirmed revision, restores both, and undoes old own work. It is NOT evidence that any brand-new client can derive the same history from `CheckpointBundle` alone. Extend this to stale saved sessions, nonempty post-checkpoint tails, fresh-process serialization, and authorized history delivery.

### 9.4 Retention and integrity

Keep late-rebase, deduplication, archive/backward-traversal, and own-undo retention distinct. Before pruning, preserve or explicitly expire each advertised capability. A checkpoint importer validates rows, root, IDs, parents/children, cycles, revision continuity, scope, schema interpretation and ledger shapes with bounded resource use. Reject corruption atomically.

Do not send a full authority checkpoint to restricted participants: it may contain hidden data, old values, receipts and ownership metadata. Bootstrap snapshots, tails and history exports must honor visibility. Do not reuse a source-to-table conversion that changes operational handles across participants.

## 10. OT test coverage: dimensions, not a headline count

The current suite has useful property tests and a real-client simulator. Keep and strengthen them. Do not replace them with hundreds of tests of formatting or empty loops.

### 10.1 Explicit operation-pair matrix

Enumerate all exported primitive kinds from the actual algebra (currently 12). Maintain a checked inventory of **ordered** pairs (currently 144 cells). For each cell state: independent/compatible cases, geometries that conflict, genuinely inapplicable combinations, and links to executable cases. An inapplicable cell needs a structural reason, not `skip`.

Within relevant cells cover: same/different targets, ancestor/descendant, disjoint nested paths, array occurrences including equal duplicates, positions before/at/inside/after ranges, touching and overlapping boundaries, full containment, exact overlap, insertion at start/end/empty content, moves in both directions and between parents, split/merge crossings, no-op and fully consumed effects, and Unicode coordinate boundaries. Exercise both argument orders and origin precedence orders. Do not require 15 artificial examples in a trivial independent-target cell; do not settle for one example in a rich overlap cell.

Table-driven fixtures can generate thousands of cheap checks with compact maintainable code. Output a report of cases per pair and semantic class. The acceptance criterion is covered behavior, not reaching exactly 1,000 names.

### 10.2 Check semantics as well as convergence

Every deterministic case identifies the expected effective state or expected conflict **independently of the transform under test**. Check transformed addresses and before/removed payloads for critical cases, both application branches, state-free decoded inversion of both transformed results, structure/identity/order, no loss of surviving concurrent insertions, and unchanged input versions.

A transform returning two equally wrong deletions can pass a diamond. A transform rejecting all interesting cases can avoid divergence. Explicit allowed-outcome cases and acceptance quotas by class prevent both. Invariant-bound conflicts are checked under the same authority decisions, not a fabricated symmetric-success requirement.

### 10.3 Strengthen generators and the simulator

The default algebra file currently attempts 3,000 seeds in each of two tests; the normal three-client simulator uses 150 histories × 40 scheduler steps. `test:property` sets a common budget of 2,000 and 120 steps: it expands the simulator, but **reduces each 3,000-seed algebra loop to 2,000**. A scheduler step is not necessarily an accepted operation. Report actual generated/valid/compatible/conflicting/failed counts; separate budgets by suite.

The generator currently uses small documents, a limited value corpus, all major primitive families, and short composites. Add targeted generators for rare geometry classes, larger/deeper nested structures, multiple contributions from one replica, long compound edits, constraints, ownership changes, checkpoints/pruning/join interleavings, and restored history. Track which distributions actually occurred.

Do not silently `continue` for an unexpected `ApplyError`. The first current property test checks apply-time refusals are cycles; the dense test skips every `ApplyError`. Replace broad skips with explicit expected categories and regression cases. A `conflict` returned by the implementation is not its own proof that rejection was allowed. Preserve failing seeds and serialized minimal counterexamples; reduce operations/data, not only the prefix length, where practical.

Use model/reference oracles for common text/array cases and for optimized validation. Reusing the same builder/apply implementation on both sides can mask shared bugs. Test real client queues, receipts, publication, undo/redo, reconnection and catch-up, not just primitive pairs. No arbitrary TP2 promise beyond the chosen control profile: specify and test its actual context assumptions and permitted histories.

### 10.4 Fault sensitivity and execution

Keep negative controls; verify deliberate local faults are killed by assertions: offset off-by-one, duplicate-value search, lost inner insertion, stale inverse payload, swallowed conflict, duplicate delta, premature publish, snapshot-tail duplication/gap, lost history on restart, schema constraint omission and stale async result. Do not call a test of a hardcoded wrong constant a mutation test of the real implementation.

Preserve a fast deterministic Bun suite and a reproducible larger fuzz/simulation job. Record seed intervals, budgets, operation-pair counts, runtime/environment and actual failures. Test speed is measured; no imposed claim of sub-second runtime across all machines. Existing scenario IDs remain a traceability aid, not a replacement for real coverage.

## 11. Hosting, distribution, documentation, performance

### Async-capable durability boundary

Keep pure synchronous state/OT functions where useful. Add an async-capable host/store boundary for external databases/object stores. Await durable append and its terminal receipt before success/publication. Revalidate/rebase after a failed compare-and-commit; preserve owner fencing. Serialize mutations per authority while I/O is outstanding or use an equivalent tested strategy. Checkpoint stage/publish/prune must also support delayed I/O and safe ownership/cut checks. An in-memory or synchronous adapter may coexist. No production backend is required.

### Direct repository consumption

Support the owner's actual distribution path: a pinned Git commit checked out/submoduled/workspaced and built by the consumer. A tested prepare/build-on-install path is optional, not required. No npm token/publishing task. Test a genuinely fresh consumer using only the public package exports and its documented build sequence, with no preexisting `dist` or internal source imports. Make declared Node/Bun versions match real tests. Distinguish Node worker threads from Cloudflare Workers.

### Consumer documentation

Create concise linked guides (organization delegated) for document/source format, schema authoring and supported keywords, operations with fields/coordinates/inverse/conflict policies, collaboration and join, snapshot/checkpoint/undo retention, proposals/agent use, ownership and runtime scheduling, direct Git installation. Snippets execute in tests. Docs must describe actual APIs, not merely repeat "must" requirements.

Remove stale names and contradictions, including old `removeArrayItem` comments, recursive-provider claims, root-ID caveats once repaired, nominal schema compliance, unconditional immutable-object claims, and stale test/runtime numbers. Clearly identify implemented proposal primitives versus absent review UI.

### Performance truthfulness

Retain the current persistent index unless correctness/measurement justifies replacement. It is a bucket-sharing map whose update copies the bucket pointer array, not a proven O(log N) HAMT. Child arrays and strings retain their costs. Benchmark representative common edits, structural changes, realistic validation enabled, undo/history updates, recovery, and public-runtime dependencies. Record warm-up, repeated samples, environment and document shape. Mean, median and tail samples must not be presented as interchangeable. Source pages are a workload label, not a rendered-page benchmark.

Do not set machine-specific sub-millisecond claims as universal correctness gates. Preserve useful performance without discarding contracts. Real editor/deployment benchmarks belong to the first consuming applications.

## 12. Execution order and completion

1. Inspect actual checkout; run clean baseline gates; reproduce and classify F01–F18. Keep exact results. Do not quietly update expected results to match bugs.
2. Repair schema/validation and lossless codec/diff paths. Strengthen ownership without mandatory deep freeze. Add focused public-API regressions.
3. Complete and test snapshot-based join/history restoration, checkpoint integrity, async host contract and async derived propagation.
4. Correct provider document routes and capability evidence; add independent offline tests and opt-in live probes.
5. Build the pair/geometry inventory and systematic cases; strengthen generators/simulator and negative controls; add clean consumer tests and user docs.
6. Run all repository gates, full deterministic matrix, larger properties/simulations, examples, build/public API, and applicable benchmarks. Run live probes only explicitly opted in with credentials.

Keep implementation increments small and genuine, but continue through the mandatory scope. If an external live check is unavailable, report that specifically; do not use it to skip local implementation/tests. Preserve lint/file-size/dead-code checks and English repository content.

Deliver: actual commit(s); concise summary of repairs; F01–F18 disposition; remediation acceptance-to-test mapping; pair/geometry report and seed budgets; command outputs; supported ownership and join/history contracts; installation recipe; truthful remaining limits. Do not declare completion from scenario-name counting or green legacy probes alone.

## 13. References and how to use them

Repository evidence is pinned to the reviewed SHA. Base URL:
`https://github.com/AnimaticML/ml-collab-codec/tree/73a782d17961b086d6e05a2fb65a3e0bf288f231`

- State/checkpoint/tail: `src/core/checkpoint.ts`, `host.ts`, `authority.ts`.
- New client and history: `client.ts`, `client-types.ts`, `history.ts`, `client-undo.ts`; `tests/support/room.ts`; `tests/acceptance/r-control.test.ts` R37–R39.
- Test budgets and blind spots: `tests/unit/transform-properties.test.ts`, `tests/support/gen.ts`, `tests/support/random.ts`, `tests/acceptance/r-simulation.test.ts`, `package.json`.
- Provider schema assertions: `src/core/providers.ts`, `provider-decode.ts`, `tests/acceptance/s.test.ts`.
- Historical probes: `review-evidence/ml-collab-codec-review-probes.mjs`; see its companion README before running.

External primary references verified for the schema boundary on 2026-09-26:
- JSON Schema 2020-12 validation: `https://json-schema.org/draft/2020-12/json-schema-validation`
- JSON Schema annotations: `https://json-schema.org/understanding-json-schema/reference/annotations`

These explain the standard, not the current library's correctness. Current model/provider capabilities must be checked separately by the implementer against the relevant official docs. No external reference overrides accepted owner semantics.
