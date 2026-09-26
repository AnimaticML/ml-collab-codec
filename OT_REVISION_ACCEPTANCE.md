# OT revision v3 acceptance: R01–R54

Read the v3 `OT_REVISION_HANDOFF.md` first. These are required scenario families for the existing implementation, not a completed test report, API specification, or permission to implement one special case per ID.

Retain the original acceptance intent. Strengthen overlapping original scenarios rather than maintaining conflicting expectations. In particular, P06 can no longer pass by reporting supported-profile collaborative undo as unimplemented. Wire all revision families into the normal test/inventory workflow. No TODO/skip/focus or empty cases satisfy revision acceptance.

Notation: text and array offsets below are zero-based; deletion ranges are half-open. Operations called concurrent share the stated base. Later/dependent operations are authored in the state after the preceding effect. Translate this notation into the library's actual public operations and context representation.

For compatible cases, exercise both branches/application orders where the chosen protocol permits them, not just the server order convenient for the implementation. In particular, same-gap concurrent insertion content follows the stable origin rule under different authority admission orders. For invariant or incompatible-write arbitration, fix the authority decision sequence when comparing clients; changing arbitration can legitimately change the survivor. Assertions include explicit outcomes, stable origins, contexts, and absence of lost work, not only final equality.

R01–R44 retain and strengthen v2 coverage. R45–R54 make the final identity/context/ordering/finality scope executable. Do not replace existing operation/history/runtime tests with the easier protocol-only cases.

## A. Occurrence identity, sequence operations, and transformation coverage

### R01 — Same duplicate occurrence deleted twice

Base `['a', 'a', 'b']`. Two clients both select and remove index 0 in that base. Final state is `['a', 'b']`; the second effect is already satisfied. The second request does not search for and delete the remaining equal value. Exercise transformed replay and duplicate network delivery separately: they are different cases.

Repeat with equal object-valued occurrences. The fixture may label original occurrences in the test oracle, but must not require application-visible IDs in the input array.

### R02 — Distinct duplicate occurrences and intervening edits

On the same base, one client removes original index 0 and another removes original index 1. Final state is `['b']` when constraints permit it. Requests remain distinct even though both original values equal `'a'`.

Add an intervening insertion before both targets and verify positional remapping. Add a concurrent mutation of one object occurrence and exercise the documented delete/edit conflict policy; never remove its equal-looking neighbor instead.

### R03 — Concurrent insertions inside deleted original ranges

Text: base `abcd`; A deletes original `[1,3)` (`bc`); B inserts `X` at 2. Both compatible paths yield `aXd`. Explicitly inspect the path through `abXcd`, which must preserve `X` while removing original `b` and `c`.

Array: base `['a','b','c','d']`; remove original indexes `[1,3)` concurrently with insertion of `'X'` at 2. Final sequence is `['a','X','d']`.

Extend to multiple inserted runs and overlapping deletes. Prove all transformed components are applied; returning a batch and silently consuming only its first component must fail the tests.

### R04 — Nested array paths and occurrence movement

Use a node property containing an editable array with two equal objects, including nested text/scalar fields. Update a field of the second original object while another client inserts a prefix item. The field update follows the original occurrence, not the new current index.

Exercise supported array reordering/movement concurrently with an edit inside the moved occurrence, and nested indexes changed at more than one path segment. No compulsory persistent IDs are added to ordinary JSON values to pass the fixture.

### R05 — Authoritative invariants and correct no-op classification

Base `['a','b']`, trusted schema `minItems=1`. For authority order remove-a then remove-b, accept the first, reject the second, and keep `['b']`. Reverse order keeps `['a']` under the corresponding rejection. Two removals of original a keep `['b']` and the second effect is already satisfied.

Use `['a','a']` to repeat the distinction for same versus distinct original occurrences. A client-supplied lower `minItems` does not bypass the schema. A staged multi-step replacement with temporarily empty contents can succeed if its final candidate satisfies constraints and all primitive safety checks.

### R06 — Old-value preconditions are not target search

Select a concrete array occurrence in a known base; then change or delete it while another equal value remains elsewhere. A stale removal/update follows the contextual target or returns the declared conflict/already-removed result. It never searches for a different matching value.

Where a request or stored inverse carries expected old data, verify those data as preconditions/evidence in the right context, not as identity. Cover differing-set versus nested-edit overlap as well as array removal. Test stale addresses resolved in the base, not looked up naively in the current tree.

### R07 — Rich-text changes crossing structural boundaries

Retain the exact wrap scenario: base `Term 10 days.`, one actor wraps original `10` in an emphasis node, another replaces it with `15`; keep both effects.

Also split `abcdef` after original `c` while another actor deletes original `bcde`. The surviving text, concatenated in document order, is `af`; both sides of the split must be processed. Exercise a replacement crossing that boundary, merge after split, and move of surviving ranges. Record exact structural/identity results for the chosen representation before writing the expected oracle.

Use Unicode fixtures and both transform directions. Do not count only a range entirely before or entirely after a split as cross-boundary support.

### R08 — Concurrent insertion ties remain editable

Insert X from `replica-a` and Y from `replica-b` into the same gap between A and B from a common base. Both survive as A-X-Y-B under the §5.6 origin ordering, with no duplicate identity. Reverse authority admission order and network delays without changing that content order. After convergence, insert Z specifically between X and Y and verify A-X-Z-Y-B, independent of Z's source ID.

Repeat with equal-looking values, multiple contenders, movement into the gap, and another round of insertion. This detects ordering schemes that can sort a collision but cannot address future positions inside it. No correctness claim may rest solely on the name “fractional index”.

### R09 — Dependent pending contexts are propagated correctly

Base `ab`. A local client inserts X at 1 (`aXb`), then inserts Z immediately after its own X at local offset 2 (`aXZb`). A remote client on the original base inserts Y at original offset 2 (`abY`). Expected reconciled text is `aXZbY`.

Deliver the remote change before local acknowledgements and vary permitted receipt order/buffering. Both local operations survive once, with updated contexts. Add create-then-edit and split-then-edit chains; never transform every queue entry as though authored in the common original base.

## B. Inversion, sequential composition, and grouping

### R10 — Every supported effective primitive is reversible

For each supported primitive, construct a valid base and build a complete reversible record before applying it. Derive its inverse from the serialized/deserialized record alone, apply the actual forward effect, and apply that inverse in its valid post-context. Restore effective values, text, ordering, persistent IDs, references, supported opaque data, and subtree structure. Keep the original base only as an independent test oracle, not an input to inversion.

Include set/remove, editable-array insertion/deletion/reordering, node insertion/deletion/move, text splice, split/merge, and delta. Equal-valued array occurrences and significant whitespace must be represented. An already-satisfied request does not create an inverse that removes someone else's effect.

Serialize each complete record before inversion. In a fresh context/process with all builder caches and pre-state history unavailable, call the state-free inversion API on the deserialized record. Use the post-state only to apply the inverse and compare against an independently held oracle. `invert(record, oldSnapshot)` as the only public mechanism does not pass.

### R11 — Atomic inverse, effective batches, and backwards history

Apply a transaction containing several dependent steps, with a repeated/already-satisfied step where meaningful. Invert actual effective steps in the right order; restore the exact effective original state without exposing intermediates.

Replay a retained multi-transaction history forward and backward from known checkpoints, including no-op/rejected receipts. Compare with saved oracle states at each accepted boundary. A failed restore due to a real identity/precondition conflict changes nothing and is explicit; do not clone the entire current document back to an unrelated old snapshot.

### R12 — Numeric profile: apply, undo, and arithmetic boundaries

Initial additive value 10; independent +2 and +3 converge to 15. Undo only the +2 contribution after the +3 effect; get 13, not 10. Redo returns to 15 in this compatible case. Repeating one transaction or receipt does not repeat any arithmetic effect.

Check all supported arithmetic boundaries, invalid numbers, and overflow behavior. If the existing code accepts broad machine-number inputs, include values that expose rounding and order sensitivity: either satisfy the declared profile or reject them explicitly. Test isolated inverse restoration and any permitted delta composition; do not silently claim exact identities outside the supported arithmetic domain.

### R13 — Real sequential composition and its limits

Within one intended atomic change, compose consecutive typing insertions, same-direction adjacent deletions, and same-field assignments such as 0→1→2. Result equals sequential application, and undo of the composed change restores the before-first state. Demonstrate actual simplification for these baseline cases, not only list concatenation.

For more complex changes, a coherent composite is acceptable. Check retained mapping/provenance where anchors or subsequent undo need it. Do not assert that equal end states alone justify transforming against a compressed accepted history; test the stronger identities only where the implementation relies on them.

Round-trip the composed record and invert it without source changes or an old-state cache. For same-field `10→11→14`, verify the inverse restores 10. Rebase the composition in a supported context and verify its updated inverse restores that branch's actual base; retain mapping/subchange witnesses when simplification lacks the required stronger property.

### R14 — Coalescing stops at the sent-request boundary

Use the public staging/group API to collect a typing burst and successive sets before network submission. Verify a compact supported payload with correct effective result and inverse data.

After a request becomes in-flight, deliver a remote change and retry the original request. Its ID and submitted payload remain unchanged even if its local working representation was rebased. An intentionally changed payload under that ID gets a protocol error. Transport coalescing never rewrites already acknowledged history.

### R15 — User grouping is independent of transport batching

With an injected clock, test compatible typing within and outside the declared gap, nonadjacent edits, explicit close, actor/session changes, and an applied remote document change. Automatic groups follow the documented conservative boundaries; client-clock skew does not determine authoritative ordering.

Use an explicit drag/task group across multiple already-sent transactions and a compatible remote update. One own undo group remains identifiable without composing away the intervening history. Two actors using the same group label never merge ownership. One publication batch may contain several distinct user actions.

## C. Collaborative undo/redo and pending intent

### R16 — Undo a group while preserving remote contributions

Base `ab`; own insertion X produces `aXb`; a later remote insertion produces `aXbY`. Undo the own group and get `abY`. No return-to-snapshot diff may remove Y.

Also let the owner insert `XY` between a and b, then a remote actor insert `!` between X and Y. Undo the original insertion and preserve the independently inserted `!`, yielding `a!b`. Include own typing spread across multiple accepted transactions in one group and unrelated remote field changes.

### R17 — Target an older own group without erasing later work

Create an own group in one field, a later own group in an independent field, and a compatible remote group. Explicitly undo the earlier own group only. The later own and remote effects survive, and group/history bookkeeping remains coherent.

Requests targeting another author's group are not authorized merely by providing that group ID. A selected group containing a mix of still-effective and safely already-removed contributions accounts for actual effects explicitly; a real conflict must not become a partial silent success.

### R18 — Conflicting cancellation is explicit and atomic

Own assignment x:0→1, then a later effective assignment by another actor to 2. Undo of the own set conflicts rather than setting x to 0. Include a subsequent write back to 1: equality with an old value alone does not reestablish ownership of the original effect.

Own group creates a node; a remote actor later edits inside it. Undo of creation must not delete the remote work. Reject the conflicting group, keep state and history intent, and explain the conflict without leaking forbidden data. Add an independent contribution to the same undo group and prove it is not silently undone on partial failure.

### R19 — Redo follows the actual undo

Undo an own group after compatible remote changes, receive additional compatible remote changes, then redo. Restore only what the actual successful undo removed, preserving intervening work. Compare with a public-API oracle, not a replay of the untouched original request.

Exercise repeated undo/redo cycles and a partially no-longer-effective original contribution. Fresh normal local work clears the active redo branch by default; compatible remote changes rebase it rather than clearing it unconditionally. Accepted historical records remain intact.

### R20 — Undo respects current constraints and authorization

Base array `['b']` with `minItems=1`. Own action inserts a; a later action removes b, leaving `['a']`. Undo of the insertion would violate the invariant and must be rejected while a remains. This is not an already-satisfied outcome.

Revoke write rights after an action but before its undo. Recheck current rights at commit. No forbidden inverse is applied, no half-group is changed, and the undo stack does not silently lose the rejected target. Redo follows the same rules.

### R21 — Unsent and in-flight undo are not the same

Cancel a genuinely unsent local action with subsequent independent and dependent pending work. Independent work is preserved/rebased; blocked dependents are retained with explicit status rather than lost.

Then send an action, request its undo before receiving the receipt, and let the authority accept the original while the client is waiting. The original cannot disappear from protocol accounting. Either a correctly based compensating request follows or another documented correct outcome occurs; all clients converge without a ghost effect. Also test original rejection and delayed/duplicate receipts. Waiting for the authoritative result is an acceptable documented policy, not a blanket “undo unsupported”.

### R22 — New undo commands versus duplicate delivery

Verify distinct IDs and explicit target relations for original, undo, and redo requests. Duplicate delivery of each request and duplicate acknowledgement do not double-apply changes or create extra history entries.

A new user command is distinguished from a retry of an old request. Check replay, retained rejection receipts, conflicting payloads under one ID, and payload immutability after local rebase. Commands only acquire effect ownership for their actual accepted contribution.

## D. Publication batches and expensive derived state

### R23 — Large application batch has one observation boundary

Attach a counted expensive model selector and an event log through the real public subscription interface. Apply a synthetic transaction with many dependent primitive edits, including a container restructure with invalid domain intermediates and a valid final state.

No expensive callback observes an intermediate tree. At most one final model invalidation occurs for the declared publication batch. Assertions inspect the final model, affected regions, history/group bookkeeping, and subscriber snapshots. Calling an expensive function once per primitive and then suppressing its event does not pass.

### R24 — Reconciliation is published as one consistent update

Build a nontrivial dependent pending queue and receive a remote batch. Use the selected paired forward-rebase path for compatible work and the explicit private recovery path for failure/resync; counted consumers see only the completed consistent update.

Assert the expected final document, transformed pending queue, history, and anchors as well as callback counts. A long pending queue does not cause one consumer recomputation per replayed operation. No alternate production engine or renderer benchmark is required. The compatible path must not merely rebuild the entire view from the confirmed base on every remote change.

### R25 — Acknowledgements, no-ops, and rejections

Receive an own acknowledgement that does not change the displayed effective document: protocol/history status may update, but expensive model-derived state is not invalidated. Repeat an already processed receipt with the same expectation.

Reject a server transaction that has not affected its authoritative model: no model notification there. Reject an optimistic local edit: reconcile its visible removal and remaining work once, with no per-step intermediate events. Do not hide a real visible rollback merely because the authority accepted no change.

### R26 — Failures and reentrant observers preserve the boundary

Inject a pre-commit exception and an invalid final candidate. Previously published state remains intact and notification suppression is released; the next valid edit still notifies normally.

Make an observer enqueue another edit while receiving a committed update. Treat that as a subsequent coherent update, not a mutation inside the current delivery. A subscriber exception has a documented error channel and does not retroactively uncommit the transition or permanently prevent later delivery. Validate state/receipt accounting, not just a try/finally counter.

## E. Anchors, proposals, and context availability

### R27 — Anchors follow surviving content through structure

Attach a node reference, an array occurrence path, a text point, and an original-content range. Apply preceding array/text insertions, move a containing node, split and merge text, and wrap/unwrap surviving text. Each anchor follows its intended surviving target under the documented context/affinity rules.

A range that becomes disconnected may return multiple ranges; it must not silently grow to include unrelated inserted content where the anchor kind denotes original content. State the exact semantics of range versus boundary-span anchors before writing the oracle. A bare substring search is not a substitute for mapping.

### R28 — Removed targets are not equal-looking neighbors

Create duplicate-valued array occurrences and two structurally distinct equal-looking text blocks. Anchor one concrete occurrence/block, then delete it. The anchor reports its removed/orphaned result rather than attaching to the surviving equal target.

Distinguish a text caret mapping to a documented deletion boundary from a content or node anchor losing its target. Losing base history returns an explicit unavailable-context result, not a guessed position.

### R29 — Boundary affinity and proposal freshness

Test collapsed text points at exact concurrent insertion/split boundaries with both supported affinities and declared Unicode units. Record deterministic expected addresses.

Create a read-base anchor/proposal, then modify the referenced content without destroying its structural identity. Mapping can succeed while a content/version precondition reports invalidation; do not equate valid coordinates with a valid old diagnostic.

Exercise A=`Pay in 10 days.`, B=`Pay in 15 days.`, C=`Pay in 10 working days.`. Rebase the unapplied A→B proposal over the actual accepted A→C history without changing C. Applying the rebased proposal yields `Pay in 15 working days.`. Independent intervening changes must be accepted; missing A is explicit, not a fallback to diff(C,B).

## F. Full protocol evidence, safety, and delivery

### R30 — Generated multi-client histories

Use at least three real library clients and a simulated authority. Generate compatible and conflicting work with dependent pending chains, delayed messages, duplicate delivery, buffered out-of-order arrivals, undo/redo, and reconnect.

Preserve the chosen authoritative decisions while varying valid deliveries. Assert converged accepted and visible states after settling, correct outcomes, accepted compatible work, owned undo effects, and no lost pending intent. Check context correctness at each step. Keep deterministic seeds, shrink failures, and run a bounded budget in CI plus a longer reproducible command.

### R31 — Distinct retention needs and explicit recovery

Exercise the documented horizons for late-operation transforms, undo information, and archived replay. Cleanup must not break advertised undo merely because a transition is no longer needed by connected clients for rebasing.

Reconnect with stale/missing context and retain local edits/proposals for review or retry. An unavailable old undo group returns a precise non-destructive result. Opening a standalone snapshot still succeeds without any history and does not invent authorship/undo groups.

### R32 — History additions preserve restricted-region safety

Keep the public table/private-hand fixture and its existing authorization model. New inverses, removed values, history groups, undo links, anchor results, errors, exports, and receipts must not disclose forbidden content to another participant.

Undo/redo checks current rights and uses the established authorized-region path. Do not attempt to solve arbitrary hidden-field replication or encryption. Verify non-disclosure under the already declared exposure model, not a new universal security claim.

### R33 — Negative controls detect wrong-but-green implementations

Deliberately inject small faults into relevant testable components and prove the suite catches them. At minimum: value-search removal of the next duplicate; endpoint-only deletion that drops a concurrent insert; independent shared-base treatment of dependent pending; raw current→old-snapshot undo deleting remote text; retry applying delta/undo twice; intermediate expensive notifications; and inverse/old-value disclosure across visibility regions.

Also kill stale inverse payload after rebase, hidden replay-to-materialize inverses, checkpoint handles pointing only to a deleted prefix, class setters doing layout before event suppression, dropped dependency edges, and stale async layout installation.

Kill arrival/time-based same-gap ordering, re-minted origin priority after rebase/coalescing, conflation of committed order with authored dependencies, re-execution of a rejected retry, highest-counter-only fake receipts, cross-document/epoch identity collision, and stale concurrent writer commit. These mutations must fail on observable semantic assertions, not only a test-name inventory.

Also catch reject-all-stale/reject-all-post-remote-undo behavior. Real end-to-end tests still use production code; negative-control doubles do not substitute for it. Do not count a mutation as killed if the failure came only from unrelated syntax/type breakage.

### R34 — Public API delivery and unchanged regression scope

Run the actual baseline and all revision tests, built ESM/declaration consumer checks, and repository quality gates. Exercise public headless workflows for indexed array editing, grouped typing/drag, undo/redo after remote work, anchor/proposal rebase, counted notification batching, and the existing restricted-region example.

Preserve codec/provider/local-file behavior and reported portability only to the extent actually verified by executed checks. Update old P06 wording and repository instructions so optional-undo exemptions cannot contradict these tests. Document changed APIs, contexts, limits, and unavailable history behavior. Do not add editor adapters or encryption dependencies to pass this revision.

## G. Selected control, reversible serialization, and application integration

### R35 — Selected forward-control state machine

Run at least three clients with one in-flight request per document/replica stream and several sequential unsent transactions. Edits remain locally responsive while the first request is delayed. Follow every incoming compatible transition through the pending queue in both directions; assert each form's context and exact state.

Use a counted apply hook to confirm the normal compatible path advances the existing visible state with the mapped incoming result rather than replaying every pending edit from the base. This is algorithm-path evidence, not a time benchmark. Independently compute the expected state in the test oracle.

Keep distinct unsent transactions unmerged unless the application policy and the safe algebra allow coalescing. Exercise own acknowledgements, in-flight rejections, buffered delivery gaps, and recovery. A second independently allocating tab/session is a separate replica stream, not the same author's one global queue. Existing multi-client/undo cases remain mandatory.

### R36 — Transformed records retain exact reversible payloads

Create complete text/array/property/move/split-merge records and transform them across compatible concurrent operations. JSON-round-trip the output, remove all prior builder/history caches, and invert the transformed record alone. Applying it and its inverse restores the actual post-concurrent base, not the original shared base.

For `abcd` delete original bc vs insert X, verify the insertion-first branch `abXcd→aXd→abXcd`; the last step uses only serialized transformed deletion and current state. Test overlap that makes part of a deletion redundant: undo must not restore the part owned by another actual deletion. No-op effective records invert to no-op.

Tamper with removed text, old property value, or subtree payload in an original request. It is diagnosed rather than accepted as a source of invented undo data. Verification must respect the original or correctly transformed context instead of comparing an old payload blindly to a newer state.

### R37 — Immediate inversion and backward traversal from a checkpoint

Build a long history containing deletion of a nontrivial subtree, changes to duplicate array occurrences, moves, and rich-text restructuring. Save snapshot V and retain a bounded set of complete transitions ending at V. Destroy the original process state and all earlier snapshots/log data not explicitly included in the fixture's retained set.

Load snapshot V. Immediately walk backwards using inverse(deserialize(record)) for the retained transitions in reverse order, then forwards again. No prefix playback or access to unavailable pre-state is permitted. Reopening a standalone snapshot with no history must still work, but must not advertise unavailable historical traversal.

### R38 — Retained undo/redo survives checkpoint truncation and restart

Create own groups and compatible remote changes, undo one own group so a redo exists, then checkpoint at V. Persist the group's current-V-context cancellation/redo handles and their required ownership/dependency witnesses. Delete the pre-V transform prefix and restart.

A retained old own-group undo and the retained redo work using only checkpoint+tail, preserving remote contributions. Include a later superseding absolute write/colliding creation so conflict checks still work after original log entries are gone. An explicitly expired group reports unavailable; it does not fetch a deleted prefix or silently clear history.

Allow subsequent tail transactions and verify resumed undo mapping. This does not require preserving every historical version below V. Exact reverse replay and selective current-context cancellation have different retained evidence.

### R39 — Checkpoint cut, failure, and deduplication

Use a fake durable storage adapter to interrupt checkpoint creation before publication, after publication but before pruning, and during cleanup. Restore the last complete checkpoint plus tail in each case. A transaction accepted at the checkpoint boundary is included exactly once, not omitted or replayed twice.

Retry a previously accepted nonidempotent delta and an undo after restart; exact retained receipts or explicit safe expiry prevent duplicate effects. Also retry a rejected and an already-satisfied request. A scalar highest counter alone must not manufacture their outcomes. Restore a separately saved local in-flight request with its original bytes/identity. Normal checkpointing retains document/history epoch; an actual reset does not silently reinterpret old requests. Diagnose unsupported operation/schema/control-profile versions. Restricted-region checkpoint exports must not leak deleted private content.

### R40 — Composition policy differs by application, not OT rules

Use the same library with a conservative typing policy, an explicit drag/task policy, and a trajectory-recording policy. Demonstrate configurable clock/adjacency/group boundaries and a veto on unsent compression for samples that must all remain data.

Group membership, algebraic composition, transport flushing, and derived-state flushing vary independently. Accepted drag updates remain immutable but one group can undo them all. The callback cannot merge another actor's effect, rewrite sent payloads, skip required separate validation decisions, or approve an algebraically invalid composition. Default "allow" still falls back to a safe reversible composite/refusal for unsupported compression.

### R41 — Class projections update once and resolve dependencies coherently

Use headless circle C, triangle T, and connector K(C,T) classes with instance identity and a real dependency index. A batch changes both C and T many times. Install all final raw records/references silently before runtime observers can read them. At derived flush, K computes once from both final endpoints; no document operation or history entry is generated for K's geometry.

Retarget K to a different endpoint and delete an old endpoint. Update/remove dependency edges correctly: later changes to a no-longer-referenced object do not recompute K. Unchanged classes retain their identity. Counters wrap actual computations, not notifications after an eager setter already computed. Observers never see a final C paired with a stale T.

### R42 — Multiple commits coalesce into one scheduled derived flush

With an injected fake frame scheduler, publish many complete movement/resize transactions before a flush. The document, protocol receipts, and transaction history process every required transition, but the visual adapter unions invalidations and reads the latest snapshot once for each dirty derivation.

A dependency chain (text inputs→layout→bounds→connector) computes against one input revision in dependency order, without eager cascading duplicates. Unrelated objects and line layout for a position-only move remain cached. Test a pure visual scale separately from a width/font change that really invalidates layout. A one-call-per-transaction implementation does not pass the multi-commit case; a one-call-per-whole-drag implementation that prevents feedback does not pass either.

### R43 — Demand, async completion, and external runtime inputs

Read synchronously available hit-test geometry before the scheduled flush and require the latest valid result for its dependency closure. An asynchronous-only derivation must expose a versioned not-ready result, not stale data disguised as current. A later new snapshot may legitimately cause recomputation; cancelling/deduplicating the obsolete scheduled work must not suppress needed work.

Start a fake async layout for revision r, change text to r+1 or delete the object, and complete the old job. It cannot overwrite current geometry or resurrect a class. Invalidate font metrics through the application adapter without a document mutation and recompute the affected derivation. Diagnose a cycle in the reference DAG rather than spinning or exposing half-results.

### R44 — Stable snapshot/selector and failure contracts

Use a functional selector consumer and the class adapter on the same store. Snapshot identity/revision is stable when content is unchanged, previously published snapshots are not mutated, and a subscriber can unsubscribe. Same-content own acknowledgement updates protocol status without expensive model selectors.

Verify affected-path summaries with edits of nested anonymous values, reparenting, creation/deletion, and known net-zero updates. Conservative invalidation cannot miss dependencies; a documented coarse fallback must not be mistaken for an exact diff. Anchor/provenance changes may be signalled separately even if content is equal.

A projection failure does not roll back committed authority data: report it, keep/recover a coherent projection using the latest full snapshot, and process future updates. Queue reentrant commands after the current publication. Exercise these public APIs from the built package with no browser, React, or MobX dependency.

## H. Identity, causal context, deterministic placement, and final admission

### R45 — Replica-scoped identity without server or wall-clock allocation

Use two independent tabs/agents for one authenticated actor. Each allocates requests locally while offline with its own replica incarnation and increasing sequence; IDs do not collide, and neither requests a server document revision to obtain identity. The same actor label, equal timestamps, clock rollback, and different network connections do not merge their identities or undo groups.

Persist/restart an allocator and separately restore saved in-flight requests. Retrying a saved request retains its original ID/payload. If allocation state is lost, a new incarnation is used for new work rather than restarting a previously used sequence. Cover cancelled/reserved sequence gaps, canonical identifier encoding, numeric comparison, bounds, malformed counters, and exhaustion. Do not reuse a retired request ID as a new command. These are injected/fake persistence tests, not an account-management service.

### R46 — Authored, submitted, working, and accepted forms retain their roles

Build local sequential edits before submission and assign stable effect origins. Introduce remote changes before sending, while in flight, and before acknowledgements arrive. Inspect serialized records: authored origins are retained, the submitted `baseRevision` matches the form actually sent, in-flight original bytes do not change, and working/effective addresses and reversible payloads are updated for their new contexts.

Pack eligible unsent changes into a new request and expand a transformed deletion into multiple primitives. Source origins and relative fragment ordering survive; a new wrapper request ID or transformed component index must not change priority or steal ownership. Round-trip transformed and composed records, invert them without old state, and exercise undo/redo with new request IDs linked to the original contributions. Do not interpret an accepted position as the author's read base.

### R47 — Causal dependencies are not a sorted order of identifiers

Create A and B from the same confirmed revision, then let the authority accept them consecutively. Verify they are processed as concurrent forms where required rather than treating B as if its author had seen A. Separately, have a later request explicitly observe A and edit its created structure: it is dependent, even when its replica identifier sorts before A's.

Repeat with multiple optimistic local predecessors, a rejected predecessor, and recovery. Correctly rebase/preserve independent local work and retain blocked dependents. Skew timestamps and change receipt scheduling without violating stated dependencies. Sorting the transaction log by replica ID, or applying a pending entry against only the confirmed prefix while omitting its local predecessors, must fail these fixtures.

### R48 — Same-gap insertion order is independent of admission and delivery

From `ab`, concurrent X by `replica-a` and Y by `replica-b` at offset 1 yield `aXYb` under either authority acceptance order, both paired-transform branches, and valid client delivery schedules. Document revisions reflect acceptance order; content order does not infer it. Add a third concurrent insertion by `replica-c` and exercise all authority permutations for this compatible fixture.

Repeat for editable arrays and structural child lists, equal-looking values, delayed acknowledgements, and skewed timestamps. After convergence insert Z specifically between X and Y; retain that addressed position rather than globally sorting by source. Persist a checkpoint and perform another such edit after restart. Exercise origins preserved through eligible pre-send composition and transform expansion. Canonical bytewise replica comparison and numeric origin-sequence comparison are identical in the supported runtimes; locale-dependent comparison must be detected.

### R49 — Invariant and incompatible-write outcomes remain final

Base `[a,b]`, trusted `minItems=1`. A lower-ID replica requests removal of a; a higher-ID replica requests removal of b concurrently. Deliver remove-b first: it remains accepted, a remains, and the later remove-a is rejected. Its earlier claimed timestamp or lower ID cannot revoke the earlier receipt. Reverse admission order and require the other documented survivor. All clients agree on each fixed decision history.

Exercise two different concurrent assignments to the same field, an already-removed occurrence, and a later authorized undo. Keep `applied`, `alreadySatisfied`, and `rejected` distinct. An undo is a new decision, not retrospective refusal of the original action. Run the compatible insertion case beside this fixture to detect a blanket 'first arrival decides everything' implementation. Do not require invariant-arbitration results to be independent of changing the arbitration itself.

### R50 — Revision, receipt, and history scopes are distinct

Only an effectful accepted transaction advances the document revision. Several no-op/rejected requests may receive terminal receipts evaluated at the same revision; a batch of many effective primitives advances once. A request-sequence gap is not a missing accepted document revision. Local optimistic edits update their local visible context without minting server revisions. Include content-equal cases with preserved mapping/ownership effects: they retain necessary protocol/history accounting without gratuitous expensive content invalidation. Do not equate a rendering equality check with `alreadySatisfied`.

Buffer a real missing accepted transition before applying a later one. Deliver status-only receipts, repeat a receipt/broadcast, and verify progress without fabricated gaps or double effects. Distinguish document ID, history epoch, replica sequence, committed revision, and local publication identity. Route a valid request/receipt to the wrong document or a reset history with coincident numeric revisions: reject/quarantine it before mutation rather than rebasing against unrelated data. Check the authenticated association of a claimed replica; a low identifier conveys no privilege.

### R51 — Deduplication survives rejection, holes, pruning, and restart

Persist an applied delta, an `alreadySatisfied` removal, and a rejected invariant-bound removal. Retry each after intervening work and after checkpoint import. Within the retained horizon return its original authorized outcome without a second effect or a fresh validation decision. In particular, a request originally rejected must not suddenly apply merely because later edits relaxed the situation; a new attempt requires a new request identity.

Submit different bytes under the same scoped ID and require a protocol error. Create allocation gaps so the highest counter is not proof of a receipt for every smaller number. After deliberate expiry, an unknown old ID returns explicit unavailable/resync rather than fabricated success or nonidempotent re-execution. Preserve local intent and status accounting; old/restricted receipts do not disclose unauthorized history data.

### R52 — One logical authority has a host-independent atomic contract

Use a small fake durable adapter. Race two handlers preparing transactions from the same revision, or simulate a stale writer after a host handover. Enforce one effective commit at that revision; a loser reevaluates/rebases against the new context or returns an explicit retry/stale-owner result. No duplicate revision, stale candidate overwrite, or state-without-terminal-receipt commit is possible. This tests the adapter's declared serialization/fencing precondition, not an implemented consensus algorithm.

Save a checkpoint/tail and restore on a fresh host with no old process globals. Keep document/history epoch, stable effect origins, retained receipts, and undo/redo intact. Retry an old in-flight request through a different transport connection and then accept new work. Moving the host does not re-key the room or pretend to create independent accepting replicas. A separate document can progress independently without sharing that document's revision lock. No Cloudflare, on-premise routing service, consensus cluster, or load-balancer implementation is required.

### R53 — The selected scalar profile is explicit and fail-closed

Serialize and restore the advertised scalar-prefix control profile with its document/history identity, submitted base, and dependent local context. Ordinary operation submission and checkpoint import require no full vector clock. Opening a standalone document still needs neither a shared epoch nor collaboration metadata.

Supply an unknown wire/control-profile version or a request claiming a vector/multi-writer context the implementation does not support. Reject it before mutation with an explicit unsupported-profile/context result; do not silently discard the context, claim distributed support, or use it as a new deduplication identity. Keep current local work recoverable. This is a format-boundary test, not a requirement to implement a vector profile or context-plugin framework.

### R54 — Ephemeral presence and local timing do not mutate document history

Use a fake ephemeral-channel consumer while exchanging real document edits. Many cursor/activity updates and timing changes do not allocate durable-edit request IDs, advance document revisions, enter undo groups, create operation checkpoints, or invalidate document-derived layout merely as document changes. If a cursor contains a document-relative anchor, its stated base is used for mapping, not as a new accepted event.

Use the real document command/commit boundary in this fixture, not a no-op function standing in for the library. Where a host dispatcher accepts both channel envelopes, misrouting an unsupported presence envelope into the durable operation decoder must fail explicitly rather than mutate the document or manufacture a commit. This can use the existing strict decoder; no new production presence subsystem is needed.

A presence renderer may update its own visual state independently. Document snapshots, retry accounting, and converged content remain unchanged when only this channel is delayed/coalesced/dropped according to the host application's policy. No production presence backend, broadcast optimization, or new rendering framework is required.

## Evidence required at delivery

Provide a mapping of R01–R54 to actual named tests and meaningful assertions, including expansions of original scenarios. Report the exact commands and outcomes, inspected checkout revision, runtime/tool versions used, deterministic and extended seeds/budgets, minimized regressions, and identified limitations.

Report the selected scalar context, exact identity/origin encoding, insertion comparison rule, receipt/revision rules, and storage/ownership assumptions alongside the test mapping. Separate implemented behavior from future distributed topology discussion. No execution results are implied by this document.

The inventory is bookkeeping, not the oracle. Every compatible success family must actually accept the compatible work; every failure family must preserve unapplied intent and avoid partial publication. Passing a count of labels, replaying a canned transcript, or rejecting every difficult case is not completion.

No live provider call, CodeMirror/ProseMirror integration, renderer performance benchmark, cryptography implementation, vector-clock control profile, consensus system, or production deployment is newly required. Self-contained reversible serialization, checkpoint import/export, and the headless runtime/policy adapters are required code, not documentation-only suggestions. Existing externally claimed checks must be accurately reported as executed or unverified.
