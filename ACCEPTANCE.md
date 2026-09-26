# Acceptance contract

These 60 baseline scenarios plus the 54 OT revision v3 scenario families (R01–R54,
below) are normative behavior, not claims of completed tests. The baseline
consolidates the prior 45 scenarios and adds explicit coverage of legacy syntax,
identity, effective-value equivalence, replay, runtimes, and final delivery. The
revision families come from `OT_REVISION_ACCEPTANCE.md` (v3); where they overlap a
baseline row, the baseline row was strengthened rather than kept in conflict.

**Owner correction applied:** C03 and S03 no longer require preserving missing/null
presence distinctions. Effective application values are the oracle. No tagged
presence transport is part of acceptance. False, zero, and empty strings are not
accidentally treated as unset. Partial hidden data remains a different case.

Every ID has at least one literal named test under `tests/acceptance` with real
assertions against the public API (no `.todo`, `.skip`, or `.only`). Record
unselected policies in SPEC before deriving expected results for those cases.
Pure schema/provider-profile tests do not require paid API calls. Separate opt-in
live probes record real provider acceptance or an explicit credential-related skip.

## Codec and effective values

| ID  | Scenario                              | Setup / actions                                                                                                                                 | Required outcome                                                                                                                                                                         |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Mixed text round-trip                 | Text, an inline element, punctuation, NBSP, and line breaks in a mixed-content container.                                                       | Parse/print preserves order and significant text; pretty-printing inserts no new text.                                                                                                   |
| C02 | Invalid input is not a default        | Optional numeric opacity defaults to 1; an attribute contains "bad".                                                                            | A source-located diagnostic is returned; invalid source is not replaced with opacity=1.                                                                                                  |
| C03 | Equivalent optional values            | Optional opacity defaults to 1. Compare omission, null, explicit 1, explicit 0. Also test false and empty string in their own typed fields.     | The first three yield the same effective value and no semantic diff. Zero, false, and empty string are retained; required-field errors remain errors.                                    |
| C04 | Unambiguous string and array encoding | Strings "0012" and "false"; arrays ["a,b"], ["a","b"], [""], and members with significant surrounding spaces.                                   | Types and member boundaries survive. Unsafe comma shorthand falls back to typed JSON.                                                                                                    |
| C05 | Canonicalization is stable            | Serialize a valid model, parse it, and serialize it repeatedly.                                                                                 | Canonical output becomes byte-identical; content equivalence includes the optional/default policy.                                                                                       |
| C06 | Duplicate stable IDs                  | Two structural nodes contain the same persisted ID.                                                                                             | Explicit duplicate-ID error; no random reassignment or silent merge.                                                                                                                     |
| C07 | JSON block and path mapping           | Attributes, several JSON property blocks, and a data-property target address overlapping nested values.                                         | Recorded precedence is followed; object merge is recursive, arrays replace, malformed JSON errors, and ambiguous path collisions follow SPEC.                                            |
| C08 | Escaping and hostile keys             | Values contain script-closing text, quotes, less-than signs, ampersands, and dangerous object/path keys.                                        | No HTML-container escape or prototype pollution; accepted values round-trip and rejected ones have diagnostics.                                                                          |
| C09 | Attribute name normalization          | Supply camelCase, camel-case, CAMEL-CASE, a leading-hyphen name, and repeated normalized attributes.                                            | Lowercasing then hyphen conversion matches the legacy rule. The first normalized duplicate wins; JSON-key casing is unchanged.                                                           |
| C10 | JSON precedence and reversible names  | An attribute sets a field and later JSON overrides it. Use camelCase, literal dotted keys, and a property not safely encodable as an attribute. | Later JSON precedence is preserved; printing chooses a reversible encoding rather than altering property names.                                                                          |
| C11 | Unknown data policy                   | An undeclared tag/property and an explicitly allowed opaque extension are encountered.                                                          | Strict profiles report unknown data. The declared opaque escape hatch, if supported, retains its data without interpretation or silent stripping.                                        |
| C12 | Standalone file and HTML bootstrap    | A complete saved document includes a schema/version and a trusted application reference; open both as source and through a browser container.   | Both routes decode equivalent original content. Parsing never executes code/fetches resources; untrusted imported script references do not run.                                          |
| C13 | Comments, roots, and content modes    | Semantic application comments, source-only comments, multiple roots, element-only indentation, and mixed-text spaces.                           | Application comments survive. Source comments follow the recorded policy. Single-root mode errors on extra roots; explicit multi-root mode retains all. Whitespace follows content mode. |

## Structured-output schema profiles

| ID  | Scenario                                  | Setup / actions                                                                                                                                       | Required outcome                                                                                                                                                      |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Provider schema baseline                  | Export a small typed component profile for OpenAI, Gemini, and Anthropic.                                                                             | Each local static result includes representation/guarantee coverage. Live probes are separate and explicitly skipped without credentials, never fabricated as passed. |
| S02 | Unsupported constraints                   | Request export of a schema containing a provider-unsupported constraint.                                                                              | Explicit incompatibility or declared runtime validation; no silent schema weakening, unbounded any, or stringified-document fallback.                                 |
| S03 | Optional output without presence wrappers | Export optional/default fields to an all-keys-required profile and an omission-capable profile. Decode null, omitted, and explicit default responses. | Effective content agrees under SPEC. Use plain optional/nullable values, never presence-tag unions. Zero, false, and empty strings survive.                           |
| S04 | Recursive and projected trees             | Export/decode a recursive mixed tree natively for a supported profile and through a typed nonrecursive node-table route.                              | Same effective content, IDs, and mixed order; reject cycles, dangling references, invalid parents, and incorrect nesting.                                             |
| S05 | Provider complexity boundaries            | The schema or payload exceeds the selected profile depth, size, union, or field budget.                                                               | Capability diagnostic, not truncation or hidden weakening. Limits are profile-scoped and evidence-dated.                                                              |
| S06 | Wire references are not persistent IDs    | Only some nodes have persisted IDs, but every table record needs a temporary wire reference.                                                          | Decoding retains the original ID granularity; no permanent IDs are invented just for transport.                                                                       |
| S07 | Locally invalid structured output         | Provider-shaped output contains a nonexistent reference or duplicate identity.                                                                        | Full local validation rejects it before any transaction changes the document.                                                                                         |
| S08 | SDK adaptation and incomplete responses   | Simulate SDK schema rewriting, a provider refusal, an interrupted JSON response, and an API schema error.                                             | Changed guarantees are reported; no partial/refused/error response is treated as an applicable document. Live transport checks remain separately evidenced.           |

## Identity and addressing

| ID  | Scenario                              | Setup / actions                                                                                                                       | Required outcome                                                                                                                                                    |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I01 | Addressable roles, not all objects    | A schema contains a block with ID, ordinary metadata objects, and small anonymous text/inline fragments.                              | Useful boundaries are addressable without requiring an ID on every object/character; parse/print does not churn identities.                                         |
| I02 | Move, copy, split, and merge identity | Move a subtree, copy it, and split/merge a text container with internal references.                                                   | Move retains IDs. Copy creates distinct IDs and applies recorded internal-reference rules. Split/merge IDs follow the preselected policy; no duplicates.            |
| I03 | Base-relative Unicode addresses       | A stale relative address points into decoded text with an entity, Cyrillic, emoji, and combining marks; earlier edits change indices. | Resolve against the base and transform to the current address in the recorded text unit. Do not index entity spelling or reuse stale numerical paths.               |
| I04 | Reference and replacement boundaries  | Edit a child while a parent or referenced definition changes; replace a whole subtree by ID.                                          | Detect real ancestor/reference dependencies. Whole replacement stays whole unless an explicit base-aware diff decomposes it; invalid final references are rejected. |

## Operations and OT

| ID  | Scenario                                  | Setup / actions                                                                                                                  | Required outcome                                                                                                                                  |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| O01 | Additive numeric concurrency              | x=10; concurrent A:add(2) and B:add(3) in the exact-number profile.                                                              | x=15; both distinct transactions are accepted.                                                                                                    |
| O02 | Delta delivery is deduplicated            | Deliver transaction A from O01 twice, then a distinct transaction with the same delta.                                           | A has one effect and one consistent receipt. The distinct transaction has its own effect.                                                         |
| O03 | Set versus delta conflict                 | x=10; concurrent A:set(20) and B:add(3).                                                                                         | The first authoritative compatible request applies; the second incompatible request is rejected, not silently combined.                           |
| O04 | Minimum collection, A first               | [a,b], minItems=1. A removes a, B removes b, same base; authority processes A then B.                                            | [b]. A is applied; B is rejected and b survives.                                                                                                  |
| O05 | Minimum collection, B first               | Same as O04, with authority order B then A.                                                                                      | [a]. B is applied; A is rejected. Do not incorrectly require the same survivor as O04.                                                            |
| O06 | Already removed is satisfied              | [a,b], minItems=1. Both concurrent transactions remove a.                                                                        | [b]. The second removal is alreadySatisfied, distinct from the invariant rejection in O04.                                                        |
| O07 | Concurrent insertion order                | Base AB. Insert X and Y between A and B, using order keys with X before Y.                                                       | Both edits survive and all clients converge to AXYB without duplicate delivery effects.                                                           |
| O08 | Deletion preserves concurrent insertions  | Base abcd. A deletes original bc. B inserts X between original b and c.                                                          | aXd, under the adopted policy that deletion targets original content.                                                                             |
| O09 | Move with descendant edit                 | One actor moves a node; another changes text inside that same surviving node.                                                    | The node retains its ID at its new position and contains the edit; both compatible effects survive.                                               |
| O10 | Parent deletion versus child edit         | One actor deletes/replaces a parent; another edits its descendant, from the same base. Test both authority orders.               | Reject the second incompatible transaction; do not silently erase an accepted concurrent edit.                                                    |
| O11 | Concurrent moves cannot create a cycle    | Two individually valid moves would together place each node beneath the other.                                                   | Reject the second invalid transition; preserve an acyclic, unique-parent tree with no partial move.                                               |
| O12 | Inline wrap with text replacement         | Base "Term 10 days." A wraps 10 in emphasis; B replaces the same original 10 with 15.                                            | Effective content is "Term <emphasis>15</emphasis> days." Both effects are retained.                                                              |
| O13 | Split boundary affinity                   | Split a text container while another actor inserts exactly at the split boundary.                                                | Both edits survive at the side specified by the recorded affinity. Assert the concrete chosen outcome, not whichever the implementation produces. |
| O14 | Temporarily invalid transaction           | A restructuring batch temporarily leaves a required collection empty, then fills it; final structure is valid.                   | One accepted atomic transition. No intermediate invalid state is published or saved.                                                              |
| O15 | Invalid final batch is atomic             | A batch includes a valid change followed by a final invariant violation.                                                         | Entire batch rejected; accepted state is unchanged and local intent is retained.                                                                  |
| O16 | Free agent edit over concurrent work      | A="Payment in 10 days." Agent B="Payment in 15 days." Room C="Payment in 10 working days."                                       | Compute diff(A,B), rebase over A->C, and produce "Payment in 15 working days." Never compute diff(C,B) as the agent change.                       |
| O17 | Diff does not invent addition             | A nonadditive numeric field changes from 10 to 20 in a free file edit.                                                           | Diff emits an absolute change, not add(10). Additive-field behavior is tested separately.                                                         |
| O18 | Effective equality and scalar conflicts   | Concurrent sets of the same effective value, different values, and equivalent optional/default spellings.                        | An already-satisfied effective set may no-op; different sets conflict. Spelling-only equivalence creates no semantic change.                      |
| O19 | Merge and range relocation with text edit | Merge adjacent text containers or relocate an existing text range while another actor edits surviving text in the moved content. | Both compatible structural/text effects survive with the recorded identity and coordinate mapping; no blanket stale-write rejection.              |

## Client protocol and history

| ID  | Scenario                                        | Setup / actions                                                                                                                              | Required outcome                                                                                                                                                                                   |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | Three-client convergence                        | Three clients have different pending edits, delayed acknowledgements, and reordered valid remote deliveries.                                 | All converge to the same accepted state and outcomes for fixed authority decisions; compatible work is actually accepted.                                                                          |
| P02 | Rejection with dependent pending edits          | An optimistic local action is rejected; a later local action depends on its effect.                                                          | Restore confirmed state; rebase independent pending work and explicitly retain/reject dependent intent. No action runs over nonexistent state.                                                     |
| P03 | Conflicting duplicate identity                  | A request repeats a transaction identity with different payload; repeat a rejected request with its original payload too.                    | Different payload is a protocol error; the original repetition returns the same retained rejection receipt without new effects.                                                                    |
| P04 | Reconnect after history loss                    | A client returns with base/deduplication context older than the documented retention window.                                                 | Explicit resync/retry preserving local work; no guessed transform or repeated nonidempotent effect.                                                                                                |
| P05 | Composition is not assumed transform-equivalent | Compare allowed sequential composition with transformations over accepted history boundaries.                                                | Test the actual supported identities; never compress history using an unproven transform/compose equivalence.                                                                                      |
| P06 | Snapshot replay and undo boundary               | Replay accepted transitions from a snapshot, including rejected receipts and repeat delivery. Perform collaborative undo after remote edits. | Replay reproduces accepted state. Collaborative undo of the supported profile is required (v3 §8): it is a new request rebased over later work, never an old inverse or a diff back to a snapshot. |

## Visibility

| ID  | Scenario                            | Setup / actions                                                                                                                        | Required outcome                                                                                                                                             |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V01 | Participant snapshots and histories | Two players and an observer access a public table and separate private hands.                                                          | Each receives only its authorized snapshot/history; the observer receives no private cards.                                                                  |
| V02 | No secret old-value leakage         | Only another player's private hand changes; compare states that differ solely in forbidden secrets under the same observable schedule. | No forbidden content in updates, old values, inverses, errors, logs, schema metadata, or selected receipts. Test only the declared exposure model.           |
| V03 | Authority checks access             | A client attempts to read/write a forbidden region and claims it has already validated the request.                                    | Safe authority-side rejection; no reliance on client assertions or unnecessary existence disclosure.                                                         |
| V04 | Partial replacement is not deletion | A client replaces a visible parent/object whose complete state includes unseen data.                                                   | Reject an invalid complete replacement or preserve hidden content through an explicit scoped-write contract. No defaulting/deleting invisible fields.        |
| V05 | Rights changed before commit        | Permissions are revoked after read but before application.                                                                             | Check current rights atomically with commit; no unauthorized accepted transition.                                                                            |
| V06 | Authorized reveal is atomic         | A trusted application action plays one private card into the public table.                                                             | Only that authorized card is revealed/moved atomically. Other secrets remain hidden. No domain-specific OT operation is introduced.                          |
| V07 | Complete and partial export         | Export a complete authorized snapshot and a participant-only view; reopen/reimport them.                                               | The full document is self-contained. The partial artifact is labeled and cannot overwrite unseen regions. A normal local document needs no principal/server. |

## Delivery and test quality

| ID  | Scenario                               | Setup / actions                                                                                                                                        | Required outcome                                                                                                                                             |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q01 | Execute across claimed runtimes        | Run the same representative core codec/operation fixture in Bun, Node, a real browser, and a worker-like runtime.                                      | Equivalent results, no core runtime-specific dependency. Tests must execute; bundling alone is insufficient.                                                 |
| Q02 | Built consumer and autonomous examples | Import the built ESM package and declarations from a separate consumer; run rich-text, numeric-board, hidden-hand, and standalone local-file examples. | Public imports/types work, examples use real generic APIs, and local save/reopen works without a room or hidden JSON authority.                              |
| Q03 | Property and negative-control quality  | Run seeded round-trip/diff/protocol/visibility properties and deliberately defective implementations or mutations.                                     | Minimized failures retain seeds. Reject-all, dropped-insert, repeated-delta, invalid-defaulting, and secret-oldValue defects are detected by the test suite. |

## OT revision v3 scenario families (R01–R54)

Normative text: `OT_REVISION_ACCEPTANCE.md` (v3). Each family is covered by one or more
literal named tests; the file column names where the primary assertions live.

| ID  | Family                                                 | Primary tests                                               |
| --- | ------------------------------------------------------ | ----------------------------------------------------------- |
| R01 | Same duplicate occurrence deleted twice                | `r-sequences.test.ts`                                       |
| R02 | Distinct duplicate occurrences and intervening edits   | `r-sequences.test.ts`                                       |
| R03 | Concurrent insertions inside deleted original ranges   | `r-sequences.test.ts`                                       |
| R04 | Nested array paths and occurrence movement             | `r-sequences.test.ts`                                       |
| R05 | Authoritative invariants and no-op classification      | `r-sequences.test.ts`                                       |
| R06 | Old-value preconditions are not target search          | `r-sequences.test.ts`                                       |
| R07 | Rich-text changes crossing structural boundaries       | `r-rich-context.test.ts`                                    |
| R08 | Concurrent insertion ties remain editable              | `r-rich-context.test.ts`                                    |
| R09 | Dependent pending contexts are propagated correctly    | `r-rich-context.test.ts`                                    |
| R10 | Every supported effective primitive is reversible      | `r-records.test.ts` (fresh-process inversion)               |
| R11 | Atomic inverse, effective batches, backwards history   | `r-records.test.ts`                                         |
| R12 | Numeric profile: apply, undo, arithmetic boundaries    | `r-records.test.ts`                                         |
| R13 | Real sequential composition and its limits             | `r-records.test.ts`                                         |
| R14 | Coalescing stops at the sent-request boundary          | `r-records.test.ts`                                         |
| R15 | User grouping is independent of transport batching     | `r-records.test.ts`                                         |
| R16 | Undo a group while preserving remote contributions     | `r-undo.test.ts`                                            |
| R17 | Target an older own group without erasing later work   | `r-undo.test.ts`                                            |
| R18 | Conflicting cancellation is explicit and atomic        | `r-undo.test.ts`                                            |
| R19 | Redo follows the actual undo                           | `r-undo.test.ts`                                            |
| R20 | Undo respects current constraints and authorization    | `r-undo.test.ts`                                            |
| R21 | Unsent and in-flight undo are not the same             | `r-undo.test.ts`                                            |
| R22 | New undo commands versus duplicate delivery            | `r-undo.test.ts`                                            |
| R23 | Large application batch has one observation boundary   | `r-publication.test.ts`                                     |
| R24 | Reconciliation is published as one consistent update   | `r-publication.test.ts`                                     |
| R25 | Acknowledgements, no-ops, and rejections               | `r-publication.test.ts`                                     |
| R26 | Failures and reentrant observers preserve the boundary | `r-publication.test.ts`                                     |
| R27 | Anchors follow surviving content through structure     | `r-anchors.test.ts`                                         |
| R28 | Removed targets are not equal-looking neighbors        | `r-anchors.test.ts`                                         |
| R29 | Boundary affinity and proposal freshness               | `r-anchors.test.ts`                                         |
| R30 | Generated multi-client histories                       | `r-simulation.test.ts` (seeded, shrinking, `test:property`) |
| R31 | Distinct retention needs and explicit recovery         | `r-retention.test.ts`                                       |
| R32 | History additions preserve restricted-region safety    | `r-regions.test.ts`                                         |
| R33 | Negative controls detect wrong-but-green code          | `r-negative-protocol.test.ts`, `r-negative-runtime.test.ts` |
| R34 | Public API delivery and unchanged regression scope     | `r-delivery.test.ts`, `q.test.ts`, `tests/api/*`            |
| R35 | Selected forward-control state machine                 | `r-control.test.ts`                                         |
| R36 | Transformed records retain exact reversible payloads   | `r-control.test.ts`                                         |
| R37 | Immediate inversion and backward traversal             | `r-control.test.ts`                                         |
| R38 | Retained undo/redo survives truncation and restart     | `r-control.test.ts`                                         |
| R39 | Checkpoint cut, failure, and deduplication             | `r-control.test.ts`                                         |
| R40 | Composition policy differs by application              | `r-control.test.ts`                                         |
| R41 | Class projections update once, resolve coherently      | `r-runtime.test.ts`                                         |
| R42 | Multiple commits coalesce into one derived flush       | `r-runtime.test.ts`                                         |
| R43 | Demand, async completion, external runtime inputs      | `r-runtime.test.ts`                                         |
| R44 | Stable snapshot/selector and failure contracts         | `r-runtime.test.ts`                                         |
| R45 | Replica-scoped identity without server allocation      | `r-identity.test.ts`                                        |
| R46 | Authored, submitted, working, accepted forms           | `r-identity.test.ts`                                        |
| R47 | Causal dependencies are not sorted identifiers         | `r-identity.test.ts`                                        |
| R48 | Same-gap order independent of admission and delivery   | `r-identity.test.ts`                                        |
| R49 | Invariant and incompatible-write outcomes stay final   | `r-identity.test.ts`                                        |
| R50 | Revision, receipt, and history scopes are distinct     | `r-finality.test.ts`                                        |
| R51 | Deduplication survives rejection, holes, restart       | `r-finality.test.ts`                                        |
| R52 | One logical authority, host-independent contract       | `r-finality.test.ts`                                        |
| R53 | The scalar profile is explicit and fail-closed         | `r-finality.test.ts`                                        |
| R54 | Ephemeral presence does not mutate document history    | `r-finality.test.ts`                                        |

## Remediation families (MR01–MR44)

Normative text: `ML_COLLAB_REMEDIATION_ACCEPTANCE.md`. Each family has at least one literal
named test; the file column names where the substantive assertions live.

| ID   | Family                                | Primary tests     |
| ---- | ------------------------------------- | ----------------- |
| MR11 | Same-ID node type change              | `mr-diff.test.ts` |
| MR12 | Structural and list diff laws         | `mr-diff.test.ts` |
| MR13 | Granularity and stale agent proposals | `mr-diff.test.ts` |

## Required expansion beyond the baseline

These scenarios name families, not one happy-path assertion each. Expand them into
unit/fixture/public-API tests, including success and failure cases and alternate
valid delivery orders. Use only synthetic, redistributable fixtures.

### Property tests

Generate valid supported models, malformed sources, boundary addresses, repeated
text, nested moves, and conflicting batches. Check:

- Codec equivalence and canonical-print idempotence, including null/default normalization.
- `apply(A, diff(A,B)) ≡ B`, ID stability, complete validation, and atomic failure.
- Compatible-operation diamonds for the chosen algebra, plus pending-client protocol behavior.
- Accepted-state agreement for a fixed authority decision sequence, deduplication, and replay.
- Restricted-view update correctness and bounded payload/error/metadata non-disclosure.

Persist seeds and minimized counterexamples. Run a bounded deterministic seed set in
normal CI and provide an additional longer-run command. Do not claim a universal OT
proof based on a finite test run. Numeric generators respect the declared arithmetic
profile and explicitly test overflow/invalid input boundaries.

### Multi-client simulator

Use at least three clients and one authoritative state. Vary delay, duplicate delivery,
acknowledgement order, pending dependency chains, reconnect, missing history, and
permission changes. Keep authority acceptance order fixed when comparing deliveries
for invariant-sensitive scenarios. Assert acceptance of compatible edits, not only
final equality of states. Keep rejected user edits available for retry/review.

### Negative controls

A broken implementation that rejects every stale edit can still appear to converge.
The suite must detect it. Also demonstrate detection of a dropped concurrent insertion,
a repeated numeric delta, silent invalid-value defaulting, and leakage through an old
value. Use small injected defects, mutation testing, or explicit test doubles of the
relevant component. Real end-to-end tests must still use the real library. The v3
revision adds the R33 list (value-search removal, endpoint-only deletion, shared-base
dependents, snapshot undo, repeated retries, per-primitive notifications, region
leaks, stale inverse payloads, replay-materialized inverses, prefix-only checkpoint
handles, eager setters, dropped dependency edges, stale async installs, arrival-time
ties, re-minted origins, committed-order dependencies, re-executed rejections,
highest-counter receipts, cross-document identity, stale writers, and reject-all).

### External evidence

Provider live probes and actual browser/worker execution are separate evidence from
static schema validation and compilation. Missing API credentials can leave live
probes skipped; that does not waive local exporter tests. Do not report browser or
worker portability as passed without execution. Wire the implemented package/runtime
and example tests into `bun run check`; they are part of required delivery.

### Completion inventory

`bun run acceptance:check` checks literal baseline and revision IDs in real named test declarations,
rejects acceptance TODO/skip/focus, and requires a production entry point. It is a
lightweight bookkeeping guard, not a semantic verifier. Passing it with empty tests
is unacceptable. All baseline tests and the extended test suite must actually pass.
