# Remediation acceptance: ml-collab-codec

**Companion:** `ML_COLLAB_REMEDIATION.md`  
**Baseline reviewed:** `73a782d17961b086d6e05a2fb65a3e0bf288f231`  
**Status:** required test families, not a report of tests run. Each family expands into real cases. No target number of test declarations substitutes for coverage.

Implement these alongside the existing C/S/I/O/P/V/Q and R01–R54 scenarios. Repair obsolete assertions that encode wrong behavior; preserve their intended useful semantics. The legacy 11-probe script is only evidence, and its strong external-mutation assertions are not an unconditional contract.

## Common test obligations

For each relevant family, exercise public APIs and a serialized boundary, not only private helpers. A failure must not publish partial content, alter the accepted base, consume undo unexpectedly, or lose the original local intent. Expected states/conflicts come from the specification or an independent oracle, not from calling the same transform twice. Record case IDs, actual execution counts, and reasons for any deliberately unsupported path. Model/provider calls are opt-in, not default-test prerequisites.

## A. Schema, validation, and lossless data

### MR01 — Standard schema input and migration

Load the same small domain through standard JSON Schema plus documented annotations and through the compatibility importer for the old descriptor. Check identical effective types/content rules, standard required-property syntax, enum/constant variants, local references and recursive component content. An unsupported assertion produces a capability diagnostic. No second manually maintained schema is required. Include a clean TypeScript consumer defining its schema.

### MR02 — Recursive validation of containers

Reject `[42]` for string items, wrong nested object members, invalid members of arrays of objects, invalid array minima/maxima, numeric bounds and non-finite runtime numbers. Include more than one nesting level and primitive arrays with duplicate valid values. Diagnostics name the actual item/property path. The schema's valid counterparts must succeed.

### MR03 — Entry-point equivalence and final-candidate validation

Pass the same effective valid/invalid data through source parse, JSON import, standalone validator, provider decode, proposal application and schema-backed authority admission. Match the documented verdicts; do not demand identical syntax diagnostics. Include an invalid numeric-field set, missing required property, invalid inserted descendant and forbidden child after a move. A temporarily invalid intermediate transaction may succeed if its final candidate is valid; invalid final candidates publish nothing. Differential-test optimized final validation against full validation.

### MR04 — Defaults without hidden corrections

Check optional omission, null and explicit default equivalence across decode paths and editing. Zero, false and empty string remain meaningful. Invalid types are not defaulted. Truly required missing fields fail according to the documented required policy. Invalid nested defaults fail schema registration. Validation does not mutate its input; normalization is explicit and produces a well-defined result.

### MR05 — Unknown properties at every depth

For strict mode, unknown top-level/nested/array-item keys produce diagnostics, not silent stripping. For an explicitly permitted extension, preserve its string/number/boolean/null/array/object values through parse, normalize, edit, print, parse and JSON exchange. Test strict-to-opaque boundaries and dangerous path keys without introducing prototype pollution.

### MR06 — References and global constraints

Deleting or changing a definition used in another untouched subtree must trigger the final reference policy. Validate nested reference fields, duplicate identity, required stable IDs, forbidden nesting and unknown tags consistently. A mutation batch repairing its own intermediate dangling reference can succeed. Keep domain reference identity distinct from node identity and array-occurrence position.

### MR07 — Malformed schemas and bounded input

Reject invalid property descriptors, unsupported assertion combinations, malformed local references, impossible defaults, invalid schema metadata and excessive declared resource limits. Deep documents, cyclic in-memory inputs and hostile keys fail with bounded behavior, not stack exhaustion or silent fallback. Registering a schema cannot inject executable document code.

### MR08 — Complete opaque and mixed-content round-trip

Known components with allowed extra props retain them. Unknown opaque components retain supported structured JSON blocks and scalar values, not only attribute strings. Mixed text around components preserves significant whitespace, entities and Unicode. Check `parse(print(model)) ≡ model`, stable canonical reserialization, and saved JSON equivalence. An unsupported value is rejected before successful save, never omitted.

### MR09 — Root and fragment API honesty

Exercise zero/one/multiple roots, significant top-level text, fragments and full documents. A multi-root API returns every root. A single-root API rejects extras rather than choosing one. The result metadata and docs describe actual behavior. Failures preserve the caller's original source.

### MR10 — Root identity and interpretation metadata

Round-trip a valid persisted root ID through model → table → operations → model → source/JSON. Keep `$root` as an internal address if desired without losing the external root ID. Check IDs resembling internal handles, copying/opening standalone documents, schema identity/version in the declared envelope and version mismatch on session/checkpoint restore.

## B. Diff and provider integration

### MR11 — Same-ID node type change

Transform a paragraph with ID `p1` into a heading with ID `p1`, first with identical text/props, then with changed content. The applied diff must equal the target. Cover nested and root type metadata where supported. Define/test the generic concurrent policy, inverse serialization and reference preservation. Empty success or silent fresh IDs are not acceptable repairs.

### MR12 — Structural and list diff laws

Generate valid before/after documents with node moves, new wrappers containing existing IDs, removals, copied nodes, duplicate array values, mixed content and opaque props. The applied diff equals the target and its inverse restores the base. The same transition is deterministic under irrelevant object-key ordering. Identity matching never treats equal list values as interchangeable instances.

### MR13 — Granularity and stale agent proposals

An agent changes one nested property/list region while a user changes an independent one. The proposal from A to B, rebased through A→C, preserves compatible user work. Include multiple distant text edits and ambiguous anonymous restructurings. Document and test coarse fallback boundaries; do not pretend source similarity proves identity or use `diff(C,B)`. A conflict retains the original proposal.

### MR14 — Component versus document schema exports

A component-property API exports properties and says so. A complete-document API exports a real tree or equivalent typed projection. Validate a nested mixed-content document against the actual emitted schema with an independent validator, decode it, and compare effective data. A `native`/`projected` label alone cannot satisfy this family.

### MR15 — Typed projection and mixed text

The emitted projection grammar admits every row needed by its own decoder, including text or an alternative typed mixed-content representation. Props depend on node kind. Invalid props for one kind fail either generation-schema validation or the explicitly reported local-only check. Preserve order, allowed nesting, stable IDs and temporary wire references; reject cycles, dangling links and duplicates.

### MR16 — Real limits and enforcement reports

Test just below/at/above depth, property and variant budgets for actual emitted schemas, not hardcoded input counts only. Every `generationEnforced` claim matches a real emitted keyword/structure; every weakened constraint is identified as local-only. Native recursion and projected fallbacks honor the concrete supported profile. Distinguish provider limits from internal safety budgets.

### MR17 — Decoder validation and exceptional responses

Malformed JSON, refusal, incomplete output, wrong container types, malformed wire rows, missing required values and locally invalid structures never become applicable successful documents. Both component and document decode use the same effective-value policy. Validate hostile/deep input and accurate diagnostics. No trusting `wireRef` alone as proof of a well-typed row.

### MR18 — Provider evidence and test environment

Default offline tests behave identically with provider credential variables absent or present. Use a harmless fixture value to test this; do not log secrets. Opt-in live probes identify model/API mode, date, result and skipped/error state; their absence does not fabricate passing evidence. Independent offline tests still run. No required npm publication or paid call.

## C. Ownership and runtime

### MR19 — Read-only types and supported mutation boundary

Compile-time tests prohibit writes through public borrowed snapshots, including nested arrays. Runtime tests prove valid library operations leave old snapshots unchanged and retain intended identity sharing. If deliberate JS mutation of a borrowed view is outside contract, state that and test optional guards separately. Do not require recursive freezing merely to pass legacy I1/I2.

### MR20 — Input ownership and free-edit copies

Retain an input object or array passed to a normal acquisition API, then edit the supported mutable working copy: the base remains unchanged. For an explicitly ownership-transferring API, document/test its precondition separately. Free-agent-edit A/B workflows must not alias the same mutable props into both. Also test schema-default objects and inserted subtree payloads for accidental cross-document aliasing.

### MR21 — Wire/history stability and staged failure

Modifying a legal work copy or building later changes cannot mutate sent original bytes, accepted records, inverse payloads or previous snapshots. Nested batches and rejected operations leave the accepted base and observer state intact. Post-publication bookkeeping must not alter published content silently. Protection strength must match the documented ownership policy, not claim more.

### MR22 — Async completion reaches dependents

A width computation initially reads pending layout; after layout completes, width and connector geometry become ready without a new document edit or manual full-cache reset. Verify exactly the required invalidation/recompute path and runtime notification. Exercise a multi-level derived chain and synchronous callback completion as well as later completion.

### MR23 — Replaced/stale async computations

An old callback cannot replace output after input changes, removal, same-key redefinition or a newer completed job. Include error/retry, dependency changes and external font metrics. A dependent result never treats stale layout as current. Relevant invalidations schedule correct work; unrelated input changes follow the documented freshness rule.

### MR24 — Coherent publication and scheduled work

Move circle and triangle in one transaction: connector reads final positions and recomputes as required once per dirty flush. Many commits before a frame may coalesce. Changing text width invalidates layout; pure position changes need not. Explicit current-value reads compute the needed closure. Test subscriber failure, reentrancy, rejected input and unchanged acknowledgements; no intermediate document state leaks.

## D. Snapshot, joining, undo, and retention

### MR25 — Snapshot is state, not genesis replay

Build history to revision V, serialize an authority checkpoint with a chosen retained suffix, discard original process objects, and restore state V directly. Retained transitions ending at V are not reapplied as a tail. With zero retained transitions the current state is still complete. Internal text/anonymous handles remain usable; state and scope metadata validate before publication.

### MR26 — Fresh join at a current snapshot

A brand-new client receives state V, no pre-V event log, and an authorized schema/profile context. It starts with the correct current document and empty historical undo. Its first edit/undo works normally. Taking this snapshot does not mutate/reset the authority or existing clients. Include a nonzero V, not only genesis join.

### MR27 — Stored snapshot plus nonempty tail and live race

Use stored snapshot V and accepted events through W>V. During snapshot transfer produce additional events. Reorder/duplicate delivery around the fence; every transition after V is applied exactly once and none before/equal V is reapplied. Gaps buffer or trigger explicit catch-up. Final content equals the authority. Observe a coherent catch-up publication. Test live subscription established before/after capture under the selected safe handoff protocol.

### MR28 — Join keeps addresses and permits contextual edits

Preserve anonymous and text handles from the actual operational snapshot rather than regenerate them from source. Send an edit targeting a run that existed before V, plus a concurrently moved/edited run. Edit locally during catch-up from a known base and prove correct rebase or explicit retained conflict. Persistent root identity and schema version must match.

### MR29 — Pre-snapshot own undo/redo with retained handles

Save an actor's history handles at the checkpoint context, prune old transform history, restart in a fresh process with snapshot+tail+authorized history, then undo an older own group while retaining other actors' compatible effects. Redo follows the accepted cancellation. Prove no code fetches or replays the discarded genesis prefix. Include text/arrays/moves, not only independent scalar fields.

### MR30 — Stale session versus newer snapshot

Saved session/history is at U, supplied snapshot is at V>U. Do not attach it blindly. With sufficient context, migrate/rebase or reconstruct state U plus tail; compare to uninterrupted execution. With unavailable context, report explicit history/pending recovery status, keep local intent, and avoid fabricated undo. Include a changed replica incarnation, an in-flight original, sequence persistence and group ownership.

### MR31 — History delivery and permissions

A new participant cannot undo another actor's past by receiving a snapshot. The same authorized actor on a new device can restore explicitly persisted own handles through the supported port; without those handles, history is unavailable/empty as documented. Server-owned checkpoint metadata and another participant's old values never leak. Reversion/moderation requires a separate authorized action, not ordinary own undo impersonation.

### MR32 — Corrupt checkpoint rejection

Reject missing/duplicate roots, duplicate row IDs, absent children, inconsistent parents, cycles, invalid schema values, malformed revisions/scope/ledger and noncontiguous tails. Unknown format/profile versions fail closed. Bound deeply nested payloads and operation expansion. Rejection creates no partial store/client state and does not silently overwrite a duplicate row.

### MR33 — Retention races and retry boundaries

Prune while a client is bootstrapping or reconnecting. The selected pinning/buffering/resnapshot policy yields coherent success or explicit recovery, never a guessed missing tail. Duplicate original requests—including rejected and no-op requests—retain the correct outcome within policy. Expired results never reapply a delta. Snapshot publication and truncation preserve each advertised late-rebase, archive and undo capability independently.

## E. OT verification depth

### MR34 — Complete ordered-pair inventory

Enumerate the real primitive kinds and all ordered pair cells (12×12 at the reviewed baseline). Every cell points to actual semantic cases or a justified inapplicability. A new operation cannot be added without updating the inventory. Report case counts by pair and geometry, not only overall named tests. Many data-driven cases may live in one file while retaining individual reproducible IDs.

### MR35 — Boundary geometries and independent oracles

For applicable pairs cover before/at/inside/after, overlap/containment/equality, empty and edge positions, same/different/nested targets, moves/split/merge and duplicate occurrences. Check both input orders and origin precedences; expected merged content or conflict, transformed coordinates, inverse payloads, input-version isolation and both branch inverse laws. Keep deterministic semantic examples in addition to random diamonds.

### MR36 — Generators cannot hide failures

Every generated result is classified: valid compatible, explicitly allowed conflict, invariant refusal or actual failure. Unexpected application errors fail with seed/case data. Remove broad `ApplyError` skips. A transform's own conflict answer is not the oracle. Record actual category counts and compare per-class thresholds. Separate algebra and history budgets so the larger job does not reduce another suite's coverage accidentally.

### MR37 — State-machine histories, not only pairs

Simulate at least three clients with multiple dependent pending transactions, delayed/duplicated/reordered events, own acknowledgements, rejection, undo/redo, reconnect, checkpoint/pruning and new joins. Check intermediate visible = confirmed + live pending, final accepted state, retained intent, historical availability and one coherent publication. Include realistic validators and same-target collisions, not only unconstrained documents. Preserve minimal serialized counterexamples.

### MR38 — Negative controls and fault sensitivity

Introduce controlled faults into real relevant paths or equivalent executable variants: equal-value delete search, wrong boundary affinity, lost inserted text, stale before-value, duplicate delta, failure swallowing, wrong checkpoint cut, premature publication and stale async completion. Show which tests catch each. Verify a reject-all transform fails compatibility cases. Do not count hardcoded false arithmetic assertions as implementation mutation coverage.

## F. Hosting, distribution, and delivery

### MR39 — Delayed durable append

Use an async fake store: delay successful append, force stale position, fencing and I/O failure, and interleave submissions. The authority never publishes success before durable decision+receipt; stale candidates are not installed; retries remain deduplicated. Preserve the pure core; no specific real database is needed.

### MR40 — Async checkpoint cut and ownership

Interrupt stage/publish/prune separately, including after another host acquires ownership or a new decision crosses the cut. Restore from stored checkpoint+tail to the exact accepted state and receipt set. A stale owner cannot publish an older checkpoint or prune newer required records. Prune only after durable publication and capability retention.

### MR41 — Clean pinned-Git consumer

Build/use a fixed commit from a new consumer directory with no prebuilt dist, ambient library node_modules or private-source imports. Execute public API and type-consumer tests via the documented checkout/workspace/submodule build recipe. Verify package exports and Node/Bun version claims. No npm account/token/publishing is part of acceptance.

### MR42 — Runnable consumer documentation

Execute snippets for schema creation, source/JSON round-trip, direct edits, proposal rebase, joining from snapshot+tail, retained own undo, async hosting and scheduled derived work. Document the actual operation fields, inverses, conflicts, types/units and history limits. Remove stale names, contradictory schema/provider claims and absolute performance assertions. Readers must not need to mine old handoffs for the current API.

### MR43 — Performance with the shipping guarantees

Benchmark declared document shapes with the chosen ownership policy, validation enabled, real history maintenance, normal edits, structural edits, recovery and relevant runtime invalidations. Use repeated samples and record environment/warm-up/units. Report any remaining full scans and long-text costs. Do not regress correctness to achieve a timing target or claim a node-thread check is Cloudflare verification.

### MR44 — Full regression and evidence delivery

All applicable existing tests plus MR01–MR43 pass, including built-package consumers and examples. Preserve private-region safety through snapshots, histories, proposals and runtime repairs. Provide F01–F18 dispositions, links from each remediation family to substantive assertions, operation-pair coverage, seed budgets, measured commands and honest external-check status. The historical probe script may require API migration and ownership-policy adaptation; explain changes, never force the implementation to retain a flawed old test shape.
