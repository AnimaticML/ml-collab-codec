# OT revision v3: explicit identity, context, ordering, and the complete change lifecycle

**Status:** revised implementation assignment for the existing Structured Document Library.  
**Revision:** v3, 2026-09-24; replaces both v1 and v2 files of the same names. This is a consolidated assignment, not another overlay.  
**Language and tooling:** TypeScript; Bun for development and tests.  
**Scope:** repair and complete the operation, collaboration, and history contracts; preserve the working codec, schema/provider profiles, local-file workflow, and restricted-region model.

Read this file together with `OT_REVISION_ACCEPTANCE.md`. Apply both to the actual working repository, not to a fresh copy of the earlier starter scaffold. The agent does not need the previous revision handoffs or the chat to execute this assignment.

**What v3 settles:** request identity, authored/submitted/effective contexts, deterministic ordering of compatible concurrent insertions, authority arbitration, restart/deduplication, and the limits of the selected deployment profile. All v2 requirements for complete reversible records, checkpoints, composition policies, undo/redo, anchors, and derived-state integration remain mandatory.

## 1. Authority, evidence, and intent

This revision consolidates the owner's requirements and the explicit engineering baseline selected in the accompanying discussion after reviewing the first agent implementation report. It is not an independent audit of that implementation. The reported test counts, code paths, limitations, and runtime results must be checked against the actual checkout. Do not mistake this assignment for evidence that a suspected defect has been reproduced.

Precedence for this task:

1. Subsequent explicit owner instructions.
2. This revision and its acceptance outcomes.
3. The repository's existing `SPEC.md`, `ACCEPTANCE.md`, and `AGENTS.md`, except where explicitly superseded here.
4. Implementation choices and external technical references.

The original 60 scenarios are a baseline, not the full definition of correctness. Preserve their intent and strengthen their assertions. In particular, replace the old permission to leave collaborative undo unsupported; do not preserve an obsolete assertion merely to keep the old suite green.

This is a targeted implementation revision, not permission to restart the project, change the canonical format, build a new application framework, or stop after writing another plan. Inspect, reproduce, repair, test, document, and continue through the required scope.

The owner's clarification is explicitly accepted: vector/causal clocks combined with a common deterministic rule can support a coordinator-free design; the intended advantage concerns independently handling **one document/room** on multiple accepting nodes, not merely sharding different rooms. A replicated sequencer would still coordinate its replicas, and room ownership/routing/rebalancing are real deployment work. Do not dismiss these concerns as already solved by room sharding. For this implementation we nevertheless keep one logical authority per document and a scalar confirmed context. This is a deliberate scope/finality tradeoff, not a claim that coordinator-free OT is impossible. A second causal/vector control profile is not requested.

## 2. Decisions now fixed

| Area | Decision |
|---|---|
| Control profile | One logical authority per document, optimistic local work, paired inclusion transformation (IT), and forward rebasing for ordinary compatible changes. Retain the chosen baseline; do not reopen algorithm selection. |
| Request identity | Document/history-scoped `(replicaIncarnationId, requestSequence)`, allocated by the client/adapter without a sequencer round trip. Stable origins of component effects survive rebase and permitted composition. |
| Causal context | A confirmed document revision plus explicit dependent local work where applicable. Distinguish original authorship, submitted form, and current working/effective form. No mandatory full vector clock in this profile. |
| Concurrent placement | Stable origin ordering for genuinely concurrent insertions into the same logical gap; lower replica identifier first, then numeric local origin sequence and original component ordinal. Never compare wall-clock time or current receipt position to choose that order. |
| Conflict arbitration | The authority atomically accepts or rejects against its current trusted state. An earlier accepted incompatible effect is not retroactively displaced by a later-arriving lower-ID request. Acceptance order does not claim real-world creation order. |
| Deployment boundary | Authority is a logical per-document contract, not one process for the whole application. One-document independent multi-writer scaling, consensus, routing, ownership migration, and load balancing are not implemented by this revision. |
| Client queue | One in-flight request per document/replica stream, plus a sequentially dependent unsent queue. A second tab or independently allocating agent is a separate replica even for the same actor. Editing never waits for an acknowledgement. |
| Reconciliation | Transform incoming and pending working forms together; update the visible state forward on the normal compatible path. Retain a confirmed base. Recompute privately for rejection, unavailable context, or recovery. Do not build several competing production engines. |
| Performance | Protocol correctness is independent of inverse use. Staging, coherent publication, and application-controlled derived-state scheduling—not a claim that transformation is always cheap—define the optimization contract. |
| Durable operations | Every serialized operation in the operation API/wire/history is a self-contained reversible record. `invert(record)` requires no historical snapshot, prior playback, process-local cache, or live object. Transform and compose preserve this property. |
| Checkpoints | Support standalone document snapshots and versioned collaboration checkpoints. Checkpoints preserve retained undo/redo capability without replay from genesis; history truncation is an explicit, capability-aware operation. |
| Sequences | Ordinary array occurrences use position/path plus context. No value-search identity and no mandatory persistent ID on every array element. |
| Algebra | Generic values, sequences, structure, text, moves, and supported additive changes. A transform can expand into a batch. Nine operation names are not a requirement. |
| Composition | The library owns safe algebraic composition. Applications control action/group boundaries and opt-in unsent compression through a policy interface; they do not supply arbitrary OT transforms. |
| Undo | Local and collaborative undo/redo, including a retained targeted own group, are required. Safe cancellation preserves compatible later work. |
| Runtime bridge | Read-only versioned snapshots, coherent commit events, affected-data descriptions, and an explicit adapter batching contract. Include small headless class-projection and selector examples, not a universal reactive framework. |
| Addresses/proposals | Keep version-aware anchor mapping and the A/read-base → B/proposal rebased onto C/current workflow. Address survival is not semantic freshness. |
| Deferred work | CodeMirror/ProseMirror adapters, rendering engines, encryption, and arbitrary hidden-field replication remain outside this revision. Preserve existing homogeneous-region authorization, including historical values. |

Unchanged: standalone source and equivalent JSON, unrestricted local file edits followed by parse/validate/diff, schema-selected IDs, explicit invalid-data diagnostics, optional omission/null/default effective-value equivalence without a presence wrapper, preservation of meaningful `0`/`false`/empty strings, and generic rather than domain-specific operation verbs. A local file does not require a server, history, or checkpoint.

The choice above is not a claim about market-share rankings, not adoption of an editor's data model, and not a claim to have implemented the published Jupiter or COT algorithm verbatim. Relevant primary references inform the design; their correctness results do not automatically transfer to this algebra, rejection policy, or undo mechanism.

## 3. Keep the layers distinct

Maintain these conceptual responsibilities. This is not a request for six packages or a particular class hierarchy.

- **Operation semantics:** addresses, application, inverses, sequential composition, and compatible transformations.
- **Collaboration control:** immutable request identity, contextual working forms, shared ordering rules, authoritative decisions, acknowledgements, pending dependencies, deduplication, and recovery.
- **User history:** author/session scope, groups, undo/redo selection, inverse rebasing, and history availability.
- **Publication boundary:** staging a complete change and notifying observers only after commit.
- **Address/proposal services:** remapping anchors and rebasing changes with known bases, using the same effects/context machinery.
- **Adapters:** authentication, transport, storage, clocks, and future editors. Keep ambient runtime services out of the pure core.

A high-level command may omit old values while being prepared, but it is not yet a serialized operation. A builder reads its stated current context once and materializes the complete reversible operation before it is returned for persistence or sent. Inversion after that point never requires materialization by replay. Transaction metadata need not be repeated on every primitive. A history group need not be one network transaction, and a notification batch does not change authority decisions.

## 4. Data publication and application runtime integration

### 4.1. Data is authoritative; runtime objects are projections

Apply operations to staged plain document data, not to arbitrary application classes or command objects that immediately notify their observers. Application instances, connector geometry, text layout, DOM/canvas objects, and caches are runtime projections. They are not a second independently writable document.

Provide a small equivalent of:

```ts
interface DocumentStore {
  getSnapshot(): ReadonlyDocumentSnapshot;
  subscribeCommits(listener: (commit: ModelCommit) => void): () => void;
}

interface ModelCommit {
  previous: ReadonlyDocumentSnapshot;
  next: ReadonlyDocumentSnapshot;
  publicationId: string;
  changes: ChangeSummary;
  mapping: AddressMapping;
  cause: "local" | "remote" | "reconcile" | "undo" | "redo" | "restore";
}
```

Names and types may match the existing API. A snapshot identifies the local visible content revision as well as its relevant confirmed context; server sequence alone is insufficient for optimistic views. Published snapshots are read-only and remain stable while content is unchanged. Do not expose a mutable staged table through an old snapshot. Preserve unaffected node identities/structural sharing or equivalent stable node revision tokens so consumers need not deep-compare the whole document on every event.

`ChangeSummary` describes actual document changes: created/deleted nodes, changed property paths/text/child lists, and moves with affected parents. It is not a list of derived objects guessed by the core. It must not miss an affected input. Distinguish conservative candidate dirtiness from a verified net change; use before-first/after-last effective values to discard known no-change inputs. Unsupported precision may fall back to a documented subtree/full-resync invalidation, not silently omit changes.

`mapping` concerns addresses between the two published contexts; raw internal rollback/replay steps are not public document effects. Acknowledgement or provenance/anchor changes with identical content use a separate metadata/history channel or flags, not a gratuitous model invalidation. No-op content does not erase protocol accounting.

### 4.2. Staging and atomic publication

A local transaction, received batch, reconciliation, or restore can contain many internal steps. Stage application, transforms, inverse payload updates, validation, pending reconciliation, and history bookkeeping privately. Commit once and notify only with the coherent result. No costly application projection may be called per internal primitive and merely have its eventual event suppressed.

Keep four independent boundaries:

1. A semantic transaction: one accepted/rejected unit with its own rights and invariants.
2. A publication batch: one coherent client-state transition, possibly integrating several transitions.
3. An undo group: one user action, possibly spanning many accepted transactions.
4. A derived-state flush: when an application actually needs its current projections.

A publication batch does not merge transaction IDs or remove per-transaction authority checks. A derived flush may combine invalidations from several already published commits. Validators required for acceptance still run before acceptance; they are not delayed presentation work.

Failures before commit leave the previous published state intact. A rejected authority transaction creates no authority model event. Rejecting a locally optimistic edit may change its visible state: publish that reconciliation once. Always release suppression guards. Queue reentrant writes as later transactions. A failing subscriber does not retroactively undo a commit or block all subsequent delivery; provide an error channel.

### 4.3. Integration with classes and observers

Supply a headless reference adapter that preserves runtime instance identity by node ID. It demonstrates a two-phase update:

```text
receive final ModelCommit
  → beginUpdate / suspend runtime reactions
  → create required instances, install all final records, resolve all references,
    remove obsolete instances and obsolete dependency edges
  → mark affected inputs and derived objects dirty (cheap and deduplicated)
  → endUpdate
  → schedule one derived flush; publish runtime reactions only after consistency
```

An alternative is for each stable runtime wrapper to read from the current immutable snapshot through its ID, avoiding field-copy setters. Both are valid adapter forms. In either case, mutating application state goes back through the document command/operation API. Hydrating projections must not recursively submit document edits.

The application supplies dependencies. Example: connector K depends on endpoints A and B, and optionally their computed bounds. The core reports A/B changes; the adapter's reference/dependency index invalidates K. It must update that index when K changes endpoints and remove edges on deletion. It must not require a model operation on K merely to recompute K's derived geometry.

The library cannot stop an arbitrary user-written setter from eagerly laying out text. The adapter contract therefore requires silent record installation or a real external-runtime batching primitive. Hiding only the final notification while still doing expensive work in each setter does not meet the contract.

### 4.4. Dirty does not mean recompute now

Subscriptions needed for projection maintenance are cheap invalidation signals. A derived selector/layout/geometry computation runs only when demanded or when the application flushes. Expose sufficient snapshot/change information and demonstrate injected scheduling (`schedule`/`flush`/cancellation) without importing browser globals into the core.

The reference adapter must demonstrate:

- Multiple commits before one scheduled flush: union the dirty input set, retain the latest snapshot, and compute a dirty derived node at most once for those final inputs.
- Acyclic chains: compute dependencies before dependents, or use lazy memoized reads. A connector depending on text bounds reads the bounds for the same snapshot. Avoid eager cascading observer loops and mixed revisions.
- Selective invalidation: moving a text box invalidates its world bounds/connector but not line layout when text, width, font metrics, and layout settings are unchanged. A pure visual scale is not automatically a text-reflow input; actual font/width changes are.
- Explicit synchronous demand (e.g. hit testing): flush/read the needed dependency closure for the latest visible snapshot. Never return stale geometry merely to maintain an "once per frame" counter. If a required derivation is asynchronous-only, expose an explicit not-ready result with its input version instead of labelling stale data current. Later new inputs can legitimately require another computation.
- Async work: attach an input/version token to layout jobs; discard stale completion after newer input or object deletion. A worker result is derived data, not an unsolicited document write.
- External inputs such as available font metrics: the application can explicitly invalidate affected derivations even when document data has not changed.

Do not promise one computation for an entire drag. Local document updates, collaboration, and visual feedback continue while dragging. Coalescing invalidations to an application-chosen frame/request boundary is different from postponing all work until pointer-up. Some applications need every committed event for analytics or simulation; those consumers use the commit stream rather than a latest-only visual selector.

Dependency cycles are an application concern. The example supports acyclic computation and diagnoses cycles; do not add a general fixed-point solver. The library does not infer arbitrary data dependencies from JSON Schema.

### 4.5. Functional consumers and scope

Demonstrate the same public store with a pure selector consumer: stable snapshot access, explicit relevant inputs or revisions, memoization, and filtered/late evaluation. Passing a new root to a function does not itself guarantee cheap rendering. No React, MobX, editor, canvas renderer, or production dependency graph framework is required.

Tests use counters on actual derived functions and fake schedulers, not wall-clock speed claims. Inspect model and runtime snapshot consistency, unaffected-instance identity, dependency updates, synchronous reads, and stale async results. No comparison of three production OT engines or renderer benchmark is required.

## 5. Addressing and transformation semantics

### 5.1. Ordinary editable arrays

An array occurrence is selected by an address in a known base context: for example, owner node ID, relative property path, and index/range. Indexes must be transformed when concurrent operations insert, remove, edit, or move surrounding content.

Use schema-declared atomic arrays only when the application deliberately chooses atomic replacement. That mode cannot replace support for editable sequences required here.

Mandatory distinctions:

- Removing the same original occurrence twice does not remove its next equal neighbor.
- Removing two different equal-valued occurrences remains two different removals.
- An old value can be a precondition or inversion payload, but is not a search key for finding a replacement target after rebase.
- Concurrently inserted occurrences inside a removed original range survive under the baseline insert-preserving policy. Transformed deletion may therefore contain multiple operations.
- Editing a surviving occurrence follows its index/path through preceding insertions and supported moves, including nested object properties.
- A removal versus incompatible concurrent editing of that occurrence follows the explicit delete/edit conflict policy; it never silently locates another equal object.

Replace the reported value-search `removeArrayItem` wire semantics with coherent sequence semantics. A convenience function may resolve a user's value-based selection into a concrete occurrence at a known base, but it must expose ambiguity rather than encode value search as general OT identity. Do not retain an incorrect legacy path as an undocumented fallback.

Authoritative schema constraints, including `minItems`, are checked on the final candidate. A client-provided limit cannot weaken them. Preserve the existing distinction between `alreadySatisfied` for the same removed occurrence and `rejected` for an attempt to delete the final required survivor.

Stable structural IDs remain useful; this revision does not require removing them. Internal transient handles are allowed if they are context-correct and do not become mandatory persistent IDs in every application array.

### 5.2. Text and structure

Retain the declared protocol text unit and test Unicode boundaries. Operate on decoded content, not the source spelling of entities. No mandatory persistent ID per character.

Retain these compatible outcomes:

- Move plus a surviving descendant edit preserves both.
- Wrap/unwrap plus edits to surviving text preserves both.
- Split/merge must remap edits and ranges, including a range crossing a split boundary; support cannot be limited to ranges entirely on one side.
- Concurrent original-range deletion preserves independently inserted text, in both application orders.

For base `abcd`, deleting original `bc` and inserting `X` between them yields `aXd`. After the insertion branch the state is `abXcd`: a transform must remove original `b` and `c`, not the inserted `X`. Merely adjusting two deletion endpoints is insufficient for that outcome unless the chosen result representation expresses the preserved insertion.

Use the insertion tie-break specified in §5.6; document exact boundary affinity and movement/deletion boundary cases with examples. Test future edits between previously concurrent inserts. Fractional ordering keys or stable IDs do not make those cases correct without the shared tested policy. A same-ID retry is deduplication, not another insertion contender.

### 5.3. Selected control profile and contextual obligations

Use an authoritative accepted sequence and optimistic clients. For ordinary compatible work, use paired inclusion transformation:

```text
pair(A, B, context) = (A_after_B, B_after_A)
apply(apply(S, A), B_after_A) ≡ apply(apply(S, B), A_after_B)
```

The inputs are concurrent forms in a shared context, not any two sequential operations. Output forms include updated reversible payloads and any necessary mapping/effect metadata. Iterate the pair through the sequential pending queue: as each local entry is rebased, the remote form must also advance into the context of the next entry. An entry authored after creation of a node is not independently concurrent with that creation.

Maintain a confirmed base and a materialized optimistic view. On a compatible incoming transition, advance the confirmed context, rebase the pending working forms, and apply the mapped incoming transition to the already-visible state in one private publication batch. Acknowledgement of an already-visible own effect updates bookkeeping without applying it twice. A fresh-base recomputation is a recovery path for rejected/blocked work or explicit resync, not the default replacement for forward reconciliation.

The first transport profile allows one in-flight request for a document/replica stream plus an ordered unsent queue. The unsent queue may contain several distinct future transactions and undo groups; do not combine them merely because they are buffered. Prepare the next request against the acknowledged/rebased context. Editing remains responsive during network latency. One in-flight request is a scope choice that simplifies dependency/accounting; it can limit submission throughput at high latency. Pipelined requests, multi-master/P2P control, and a full COT/ET API are not part of this task.

A request has stable identity and immutable serialized original payload after sending. Its mutable rebased working form and the authority's accepted effective form are separate; §§5.4–5.7 define their identity, contexts, and outcomes. Retried originals return the existing authorized receipt, not a new effect. Integrate effectful accepted transitions in contiguous document-revision order; buffer gaps rather than applying out-of-order indices speculatively. A receipt without a new document transition does not create a missing revision. One in-flight request per replica does not mean one active participant for the whole document.

For conflicts or invariant failures, the authority's decision—not a fictitious symmetric success—controls reconciliation. Preserve rejected/blocked local intent. A rebase conflict detected locally cannot invent a server receipt. Define when a client waits for the original request outcome or restores from confirmed state. Cross-region actions retain the existing atomic authority boundary; this profile does not authorize separate visible half-actions.

Describe and test the exact control state machine, concurrency/context predicates, tie-breaking, queue advancement, cancellation mapping, and retained metadata. The chosen restricted transformation paths must be justified; a central server alone is not an exemption from higher-order correctness. A known protocol name or success of a text-only reference is not proof of this tree/array/inverse protocol. Group undo adds its own context/effect obligations and must not be declared correct just because ordinary edits satisfy a diamond.

Document transformation expansion and its terminating measure. A transform may return several primitives; all callers process the full result. Practical limits must yield explicit, intent-preserving errors, not silent truncation or reject-all behavior. ET and inverse are different concepts; no mandatory general ET interface is added here.

### 5.4. Request identity is not a clock, an author, or an accepted position

Use a client-generated identity with equivalent information to:

```text
request identity scope = (documentId, historyEpoch)
requestId              = (replicaIncarnationId, requestSequence)
```

`replicaIncarnationId` identifies an independently allocating replica incarnation, not a human account, network connection, process hosting an authority, or server-assigned document revision. Two tabs or independently operating agents belonging to one actor need independent identities unless they actually share a safe allocator. The adapter supplies authenticated actor/session association; possessing or claiming a low replica identifier grants no rights or special undo ownership.

Allocate a strictly increasing positive integer sequence for new requests in that replica's scope. Persist the allocator safely, or start a fresh collision-free incarnation before allocating new IDs after losing it. Retries of saved old requests retain their old IDs and submitted payloads even if the current connection/session is new. Gaps are permitted: local cancellation or reserved identities need not become document events. Define an exact portable numeric range and reject exhaustion/malformed values instead of wrapping or silently rounding. The current version may use JSON safe integers; it must not compare counters as decimal strings.

Assign stable effect-origin tokens before a local insertion participates in a transform. The token contains the replica incarnation, a local origin sequence, and an original component ordinal (or an equivalent unambiguous tuple). A single change can share identity information with its request when that is safe. If several already-authored changes are packed into a new request, preserve their existing origin tokens rather than using a newly assigned wrapper ID as their insertion priority. No second independent UUID is required for each primitive. The origin sequence is allocated once per authored change and is never reused within that replica scope. It may share a monotonic allocator with request IDs; separate roles do not require separate counters or UUIDs. The agent may choose a compact allocation/encoding but must document the request-to-origin relationship and preserve it through serialization.

Only the actual source tokens determine concurrent insertion ordering. Rebase does not mint a new identity for the same contribution. Transform expansion preserves the original token plus enough stable fragment/order metadata to keep its pieces ordered and reversible; do not generate random IDs or use the current output-array index as a new origin. Safe composition must retain the distinctions needed for placement, mapping, and ownership even when its payload is shorter.

Original edit, undo request, and redo request have distinct request identities; links such as `undoOf` identify the target and do not reuse its network identity. A restored original contribution retains the placement/ownership witnesses required by inversion; do not resolve its placement by treating the new undo request as an unrelated fresh insertion. A request ID, an undo group ID, a node ID, and a local publication ID are separate roles.

### 5.5. Keep the original, submitted, and effective contexts distinct

Use equivalent information to the following; this is a contract, not a required set of classes or duplicated snapshots:

| Information | Meaning |
|---|---|
| Document/history identity | Which collaboration history the coordinates and revisions belong to. |
| Authored context and source identities | What confirmed revision and local predecessor effects the author actually used; immutable origin information where retained. |
| Submitted `baseRevision` | Context of the complete serialized form actually sent to the authority. With one in-flight request, its unsent predecessors have been resolved or safely included before submission. |
| Working/effective context | Context in which the current rebased form, addresses, before-values, and mappings apply. It changes when transformed. |
| Committed revision | Position of an effectful transition in the accepted document history, not proof that its author observed earlier accepted requests. |

A local edit can be authored over optimistic predecessors. Do not label its coordinates as valid against only a confirmed scalar revision while omitting those predecessors. While unsent, its submitted form can be prepared/rebased onto a newer confirmed context. Once sent, the exact request envelope and body remain immutable; retain a separate working form. Never overwrite original provenance with a current working context and claim the author knew those remote changes.

Two requests based on revision V can be concurrent even when committed at V+1 and V+2. A later local request that edits a node created by an earlier request is dependent on it; a lower replica ID cannot move it before its dependency. A remote event is transformed against a pending entry only in the contexts permitted by the selected control algorithm, not merely because their numeric revisions differ.

The baseline context is scalar because confirmed replicas consume a shared accepted prefix. Pending predecessor information completes the optimistic context. Do not add a full client vector, compare vector objects for deduplication, or pretend a scalar total order detects the author's actual wall-clock order. A future vector/hybrid profile requires a separate specified control/retention/finality contract; an arbitrary vector attached to this request does not enable that profile.

Version the wire/operation/control profile, schema interpretation, and checkpoint context. Unknown profile versions or incompatible epoch/context data are explicit errors before mutation; do not silently fall back to another interpretation. `historyEpoch` names a continuous history incarnation. Routine checkpoints, reconnects, and transfer of the same complete history to a different host do not automatically create a new epoch. If history is reset or an old fork is imported as a new shared history, use a new epoch and require old operations to enter an explicit review/rebase path. A new epoch does not turn a stale request into a fresh authorized mutation.

### 5.6. Deterministic insertion ties, not guessed real-time precedence

For **genuinely concurrent** insertions into the same logical text/array/child-list gap, preserve every compatible insertion and choose their relative order from their stable origin tokens:

```text
(replicaIncarnationId ascending,
 localOriginSequence numerically ascending,
 originalComponentOrdinal numerically ascending)
```

Replica identifiers must have one canonical portable representation. Use a bounded ASCII identifier encoding and bytewise lexicographic comparison of its canonical bytes, with the shorter prefix first. Do not use locale-sensitive sorting, case folding, connection arrival time, server revision, a newly rebased operation ID, or a local object-enumeration order. Numeric fields compare numerically. Select precise identifier bounds before implementation and test them; no cryptographic or fairness guarantee is implied by a smaller identifier.

Example with canonical IDs `replica-a` and `replica-b`: from base `ab`, A inserts X and B inserts Y into the gap after a. The final text is `aXYb` under both authority acceptance orders. If B was committed first, its contribution is still present when the transformed A is inserted before it; history is not rewritten. Requests receive committed revisions in authority order, while document content follows the shared insertion policy. Reversing or skewing client timestamps does not change this result.

Causal order and an explicitly addressed position take precedence over a concurrent tie. After X and Y exist, a request to insert Z between them produces `aXZYb` regardless of its source's relative identifier. Do not globally sort a document, all requests, an authored typing sequence, or a compound transaction by replica ID. Equal-looking values remain distinct occurrences; identical request identities are handled by deduplication instead of this rule.

Keep the existing insert-preserving deletion policy, split-boundary affinities, and explicit incompatible-move/delete policies. The comparator is not a universal last-writer-wins resolver. Conflicting sets, incompatible replacements, and invariant-bound deletions use §5.7. Expand/rebase/compress operations only in ways that preserve the required original contribution ordering and undo/anchor evidence. A naive pair comparator is not a proof for multiple dependent transactions; test those histories as well.

### 5.7. Finality, revisions, and retry outcomes

Choose the following accounting for this profile:

- One effectful, atomically accepted transaction advances the document revision once and stores a complete reversible effective transition.
- `alreadySatisfied` has no newly owned effect and does not advance the document revision. Record a terminal receipt with its evaluated context.
- `rejected` changes no authority document content and does not advance that revision. Retain its outcome/context and safe reason for the advertised retry horizon.
- Request sequence, document revision, undo group, local visible revision, and optional status-message numbering are not interchangeable. A request rejection or a local counter gap must not block a client waiting for a nonexistent document transition.

Here 'effectful' means a recorded semantic contribution, including identity/placement/ownership effects where the chosen model preserves them; it is not determined only by comparing rendered text or root values. A content-equal transition may still require protocol/history/mapping accounting without expensive content invalidation. Only an actual empty/no-owned-effect result is `alreadySatisfied`. Document the supported reduction of net-zero composites consistently with §§4.1, 6.3, and 8.2.

The authority serializes admission for a document, validates permissions and trusted invariants against the current candidate, and atomically commits the transition (if any) with its receipt. Earlier *admitted* conflicting work has priority in this profile; do not claim to recover which participant created it first. Host queue order is a protocol arbitration choice, not a timestamp measurement.

For `[a,b]` with `minItems=1`, if remove-b is admitted first, it remains accepted and a survives after remove-a is rejected—even when remove-a has the lower origin identifier or an earlier claimed timestamp. Reversing the authority's decisions may change the survivor. By contrast, concurrent same-gap insertions use §5.6 and have the same content order across those authority schedules. Preserve both independent success and explicit conflict semantics instead of applying one blanket winner rule.

A terminal accepted outcome is not retroactively rejected because a previously unknown lower-ID request arrives. A later authorized undo is a new transaction, not a revision of the old receipt. Provisional optimistic client application is not final acceptance. If a future coordinator-free profile chooses revisable or provisional outcomes, that must be an explicit different contract, not introduced here behind the word 'deterministic'.

Deduplicate by full request scope/identity and verify the immutable canonical submitted payload (or a collision-safe fingerprint with sufficient retained evidence). Same identity and payload returns the recorded authorized outcome without reapplying or re-running the original decision. Same identity and different payload is a protocol error. Receipt data may be projected/redacted according to existing authorization; deduplication is not a history-disclosure permission.

A highest-seen client counter is not by itself an exact receipt table or proof that every smaller event arrived/applied. Represent holes/retained outcomes where required, or use a documented expiry boundary that returns `historyUnavailable`/resync without inventing `applied` or replaying an old nonidempotent request. An expired unknown request must not be treated as new simply because its row was pruned. Stored rejected and already-satisfied outcomes are also part of retry accounting. Wire retries, duplicate accepted-event broadcasts, and repeated receipts each apply effects at most once.

### 5.8. Deployment constraints and the boundary for a future vector profile

The current model intentionally has a single logical admission/order point per document. Multiple independent documents can use different authorities, but that does **not** solve one hot document. Multiple machines implementing that one authority still need exclusive ownership or coordinated commit/order; no scaling property is obtained merely by renaming them 'coordinators'. Finding the owner, routing requests, moving ownership, fencing a former owner, and balancing rooms are adapter/deployment responsibilities and remain genuine engineering tasks.

Keep the core independent of Cloudflare, a process-global singleton, a network address, and a particular database. The same document/history and immutable pending requests must survive checkpoint export/import on a different host. Define the hosting contract: at most one effective writer for a history, or a shared serialization/atomic compare-and-commit mechanism enforcing its equivalent; state plus receipt durability; and rejection of a stale writer. A compare-and-commit retry must reevaluate against the new context, not append stale precomputed data. Use a small fake adapter to test atomicity/restart; do not implement consensus, a load balancer, a routing service, a production migration system, or benchmark room placement.

Moving a history to a new host is not moving its data backwards, changing client origins, or starting a new history epoch. A hosting ownership/fencing generation, when the adapter uses one, is not automatically a new document epoch. Checkpoints carry the context and retry evidence required by §§5.5, 5.7, and 8.4; if unavailable, report recovery requirements instead of promising transparent continuation.

Vector time plus shared deterministic arbitration is a valid future design direction. Its potential advantage is independently evolving replicas/accepting nodes inside one room and a different routing topology. It is not selected for implementation now, and attaching vector metadata would not, on its own, implement that design. The present scalar-prefix profile is retained to keep final authoritative invariant/permission decisions and a bounded control implementation. Do not build a placeholder vector engine, a selectable second consistency mode, or an unsupported pluggable consensus framework. Keep boundaries explicit and formats versioned rather than inventing abstractions for every possible future protocol.

Presence remains an ephemeral application/transport channel, separate from document mutation history, request counters for durable edits, undo groups, and durable revision advancement. Anchored presence can refer to a document context for mapping. Coalescing/throttling such messages is not document-operation composition; no presence backend is added by this revision.

## 6. Reversible changes and composition

### 6.1. Self-contained serialized reversible operations

The public serialized operation contract is reversible from creation through transformation, composition, acceptance, storage, and reload:

```text
r = buildReversibleChange(currentContext, command)
wire = serialize(r)
r2 = deserialize(wire)                 // in a fresh process
inverse = invert(r2)                  // no state/history/cache parameter
S1 = apply(S0, r2)
apply(S1, inverse) ≡ S0
```

`apply` naturally needs the relevant current document and schema. `invert` derives an inverse for the record's own post-context from the record alone. Applying that inverse later, after other changes, still requires contextual rebasing or a current-context undo handle; self-contained data is not context-free applicability.

Examples of sufficient payloads, not fixed public type names:

| Effect | Data retained in its serialized record |
|---|---|
| Property change | Address; before and after effective values, or equivalent reversible create/remove representation |
| Text splice | Target/context; offset; exact removed text and inserted text in the declared text unit |
| Array splice | Indexed occurrence address; exact removed and inserted values/subtrees |
| Node deletion | Full supported deleted subtree, identities/order/placement needed for restoration; no omitted children |
| Move | Identity plus both old and new placement in the appropriate context |
| Split/merge | Boundary, identities, placements, original properties and fragment metadata needed to reverse the actual transition |
| Numeric delta | Explicit relative intent and the data needed for exact inversion in the supported numeric profile |
| Composite | Ordered reversible parts; inverse reverses their order |

Builders can read state when first creating the record. That is not permission to return an incomplete operation and require its future consumer to replay it once to make it invertible. A convenience `applyWithInverse` may exist but is not the only means of inversion. No old snapshot, discarded prefix, live class, WeakMap, or external unbundled blob may be necessary to invert a record. Avoid copying the whole document per primitive: retain the touched data. Deleting a large subtree necessarily retains that subtree for a self-contained undo.

Treat the record's old values as checkable preconditions, not as trusted authority or a way to search for an equal target. Validate them in the stated context or through the tested rebase/verification path. Tampering cannot insert foreign data into history. Where the authority derives a different effective operation, return/store that complete effective form; retain the original request identity for deduplication. Version the operation format and diagnose old incomplete formats rather than silently marking them reversible.

#### Closure under transform

If `A_after_B = transform(A, B)`, it must contain the actual before/after/removal payload for its new context, not just changed indices. Test independently:

```text
SB = apply(S, B)
SAB = apply(SB, A_after_B)
apply(SAB, invert(deserialize(serialize(A_after_B)))) ≡ SB
```

For `abcd`, delete original `bc` versus insert `X` between them: after insertion the state is `abXcd`. A rebased deletion may be two deletions carrying `c` and `b`. Its inverse restores those characters around the retained X. Copying the original `deletedText="bc"` into an unchanged one-range inverse is invalid.

If transformation needs structural context for ancestry, it may inspect the documented current/base metadata; the resulting record must still be self-contained. Do not silently retain one full historical document per primitive as the public inversion mechanism.

#### Ownership and exactness

An `alreadySatisfied` request owns no new applied effect. Its effective inverse is empty; do not restore or delete data on behalf of an effect it did not create. Composite inversion covers only actual contributions. Cancellation history separately tracks dependencies needed to avoid stealing later effects.

Equality is canonical effective document equality: persistent IDs, supported structure/order, properties, references, text, and opaque data. It is not lexical whitespace in source formatting or runtime UI state. Optional omission/null/default equivalence remains unchanged; do not reintroduce an agent-facing presence wrapper.

Restoring a deleted object's original ID is allowed only for that original object, with collision checks. Every inverse used as a real transaction still passes permissions and final invariants. New reverse payloads observe visibility rules and cannot be exposed indiscriminately to unauthorized clients.

### 6.2. Numeric semantics

Preserve the existing distinction between absolute set and relative delta. Do not infer additivity from an ordinary diff.

Audit the declared number profile. Mathematical commutativity, inverse-by-negation, and reassociation are not to be assumed for all machine-number values. The supported profile must have deterministic convergence/replay and satisfy its inversion contract. Narrow additive values to an explicit safe profile where necessary rather than silently sacrificing correctness. Ordinary non-additive number properties can remain supported separately.

For isolated exact rollback, retained previous values may be appropriate. Collaborative undo of an additive effect must preserve compatible later additions rather than set the whole field back to its historical value. Reject unsupported arithmetic or limits explicitly. Do not turn this task into an arbitrary-precision numeric platform.

### 6.3. Sequential composition and reversible compression

Provide `compose(A, B)` for changes where B follows A. The composition may be a reversible composite rather than one primitive:

```text
apply(S, compose(A, B)) ≡ apply(apply(S, A), B)
apply(apply(S, compose(A, B)), invert(compose(A, B))) ≡ S
```

The inverse is derivable from serialized composition alone. For a continuous same-field set chain `10→11`, `11→14`, the compact result is `10→14`, not `11→14`. Text compression preserves the exact original removed text and final inserted text. Numeric composition obeys §6.2.

Do not infer transform/mapping equivalence merely from equal final states. The safe default retains subchange boundaries or mapping witnesses needed by the control/history/anchor contracts. Only simplify a supported case once those required properties are established. A compound container is a valid fallback, not a reason to skip implementing the tested simple compression cases.

Implement safe consecutive typing, same-direction adjacent deletion, and same-field set compression inside an explicitly eligible unsent transaction. The same serialized composed form must remain reversible after a round-trip and transformation. Never rewrite accepted/in-flight payloads or remove separately required authorization/invariant decisions. Compression of the full accepted log is not this API; use the checkpoint/retention mechanism in §8.4.

## 7. Grouping, metadata, and pre-send coalescing

### 7.1. Transaction/history envelope

Provide equivalent information to the following, at the transaction/history level rather than copied into every primitive:

| Information | Purpose |
|---|---|
| Document/history scope and request identity | `(documentId, historyEpoch, replicaIncarnationId, requestSequence)` or equivalent; exact retry identity, independent of commit order. |
| Authenticated actor and session identity | Attribution, undo ownership, and isolation of grouping between sessions. |
| Source effect origins | Stable placement, ownership, and subchange identities through rebase/composition; not regenerated from the accepted position. |
| Authored, submitted, and working contexts | Preserve what was read and which form the coordinates/before-values apply to; see §5.5. |
| Committed document revision / evaluated receipt context | Effectful transition order versus the context of a terminal no-op/rejection; see §5.7. |
| Undo group identity | An explicit gesture, typing event, or agent task that can span network transactions. |
| Origin timestamp/local timing information | Configurable grouping heuristics and UI, not authoritative ordering. |
| Undo/redo target linkage | Trace a new compensating request to the retained group/effect being undone or redone. |

Clock/identity acquisition and counter persistence are injected or provided by adapters. User-interface timing is not used for ordering or deduplication. The authority derives/checks actor and replica association from trusted context. A claimed actor, low replica ID, or `undoOf` field is not authorization. A full vector is not required by this envelope.

Keep a sent transaction's request identity and payload immutable. Store rebased local working forms separately. Retrying the original ID with a modified payload remains a protocol error.

### 7.2. User-visible groups

Provide explicit group boundaries for gestures and agent tasks. Implement a configurable default typing policy using same actor/session, compatible edit kind/target/adjacency, a time gap, and an explicit close operation. Record the chosen threshold as an engineering default and test it with an injected clock; it is not a product-wide timing requirement.

The conservative automatic policy closes on an incompatible local action, explicit boundary, session/actor change, or applied remote document change. An explicit compatible gesture/task group may continue across remote activity without rewriting the intervening accepted history. Never infer one shared group just because two actors used the same label or time window.

A group can span multiple accepted transactions. Grouping does not require physically composing them. Keep the relationships needed to rebase each contribution and invert only the group's effective contribution.

### 7.3. Coalescing before submission

Expose a usable staging/group/builder path so a caller can combine eligible unsent changes before assigning/finalizing a network request. Define where the unsent-to-sent boundary lies; document that one low-level submit per keystroke is not automatically a grouped user action.

Minimum safe cases: consecutive typing, successive sets of the same field within one intended transaction, and supported adjacent deletes. Preserve source effect origins needed by §5.6 when unsent changes are packed under one request. Never change an in-flight or accepted payload under its existing ID. Do not collapse transactions that are intended to have separately observable authorization/invariant decisions into one transaction without an explicit caller boundary.

Undo grouping must continue to work even when no transport coalescing occurs, including a long drag whose intermediate states were already sent. Conversely, sharing one notification batch does not force unrelated actions into one undo group.

### 7.4. Application-defined policy; library-defined algebra

Expose an equivalent of separate read-only policy decisions:

```ts
interface HistoryPolicy {
  group(context: GroupingContext): "extend" | "start-new";
}
interface CoalescingPolicy {
  allow(context: UnsentCoalescingContext): boolean;
}
```

The contexts include authenticated actor/session scope, explicit action/gesture/task token, target and edit kind, timing, adjacency, intervening changes, and unsent/sent status. Policy metadata labels actions; it does not create domain-specific operation primitives. Provide explicit begin/end/close boundaries and an injected clock. A policy may be supplied as trusted local application code; it is not executable content in the document schema.

An application can veto a merge or choose a group. It cannot override ownership, contexts, reversibility, safe arithmetic, sent-payload immutability, or algebraic validity. `allow=true` means "attempt a supported safe composition", not "drop anything this callback dislikes". Unsupported composition retains reversible parts or returns a documented refusal. Different clients may have different local grouping preferences without changing deterministic remote operation semantics.

Ship a conservative typing preset and explicit-action grouping. Demonstrate at least:

- Text editor: adjacent own typing with a configurable gap; cursor/action changes close the group.
- Canvas drag: one explicit gesture group; many accepted positions remain individually accounted for, while only eligible unsent replacements are compressed. Undo spans the gesture.
- Agent task: one explicit action group across its accepted transactions; no wall-clock guessing of task completion.
- Trajectory recorder: preserve every sampled point as document data and veto destructive sample compression. This may still be one undo group.

Notification scheduling is configured independently. One frame can display several groups; one group can last many frames; transport may flush while the group stays open. Separate immutable audit history from user undo grouping and from latest-only runtime projection.

## 8. Undo, redo, and history policy

### 8.1. Required operations

Provide ordinary local undo/redo and collaboration-aware undo/redo for the caller's retained own groups. Support latest-own-group undo and an explicit target-own-group API in the retained, supported profile. Do not require a history UI, cross-user administrative undo, or arbitrary dependency-cascade repair.

An undo request is a new authoritative transaction carrying a relation to its target. It does not erase accepted history or reuse the target's transaction ID. Redo is another new transaction. Both pass current authorization and final invariant validation.

Derive cancellation from the target's actual applied contribution and its context, then reconcile it with intervening accepted work using a tested mechanism. A raw old inverse is valid for exact rollback in its original context, not automatically in the current document. A diff from the entire current state to a pre-action snapshot is not selective undo, even when limited to a field that other people have also edited.

For example:

```text
Base:                 ab
Own insertion:        aXb
Later remote insert:  aXbY
Undo own insertion:   abY
```

Also preserve remote text inserted inside the user's inserted range when cancelling only the original characters. Record what was actually undone. Redo derives from the actual effective undo and its context, not blindly from the original request.

### 8.2. Baseline conflict policies

- Compatible intervening text/sequence/other-field changes must not be rejected merely because they are later. Preserve them while undoing the selected own effect.
- If a later effective write superseded an own absolute field assignment, undo of that assignment conflicts rather than overwriting the later value. Returning to an equal value does not prove the original writer still owns the field's effect; inspect context/provenance.
- If undoing an own structural creation would delete later work inside that structure, reject the conflicting undo rather than destroy that work.
- If the exact removable contribution was already removed, report an explicit no-remaining-effect outcome without deleting a neighbor or creating a duplicate undoable action. Do not confuse this with a failed invariant check.
- A group is undone atomically. Compatible portions are not silently cancelled while a conflicting portion is ignored. Safe no-longer-effective contributions may be accounted for explicitly; ambiguous or conflicting contributions reject the group.
- Failed permission, identity, or invariant checks leave state unchanged and retain the target group and request for inspection/retry. Rejected undo does not silently pop an item from the history stack.
- Fresh normal local work clears the active redo branch under the default policy, but preserves immutable accepted history. Remote work rebases redo and may make it conflict; it does not automatically erase the redo opportunity.

Record more precise boundary/dependency policies with examples before implementing them. Do not present a conflict fallback for every post-remote undo as completion.

### 8.3. Pending and in-flight actions

Cancellation of a genuinely unsent edit can remove it from the queue; retain/rebase independent subsequent intent and explicitly retain blocked dependents.

An in-flight request cannot be assumed cancelled because a client removed it locally. Support a deterministic outcome when undo is requested before the original receipt. It is acceptable to keep the request pending until the original outcome/context is known, then send a properly based compensating transaction. It is not acceptable to forget an already-sent request that the authority later accepts.

Repeated requests and duplicate receipts do not apply a delta, undo, or redo twice. Keep enough identifiers and effective history to distinguish transport retries from a new user command.

### 8.4. Snapshots, checkpoints, and retention

Implement checkpoint export/import and exercise it in a fresh process. Do not defer checkpoint semantics until production integration.

**Document snapshot:** the standalone source or equivalent JSON containing current document content. It opens without history and invents no history. It is not promised to restore a collaboration session or past undo groups.

**Collaboration checkpoint at accepted context V:** a versioned, coherent bundle containing the snapshot, document identity/history epoch, schema/operation/control-profile versions, committed revision V, retained undo/redo descriptors already valid at V, stable contribution origins, group/ownership/dependency metadata needed for safe cancellation, and exact retained receipts plus safe deduplication/expiry evidence as required by §5.7. Anchors retained by the session have a defined V-context as well. Optional archival records can be retained separately. Creating a checkpoint does not by itself reset request sequences, change insertion ordering, or create a new history epoch.

**Tail:** complete reversible accepted changes and relevant receipts after V. Loading checkpoint V plus its retained tail restores the later state/history; no event before V is required for that advertised restore path. Persist local unsent/in-flight work separately from the authoritative snapshot, preserving original sent bytes/IDs and working contexts.

Two different questions must stay distinct:

1. Can this record be inverted? Yes, from its serialized payload alone.
2. Can its old-context inverse safely apply now? Only with subsequent context information or a retained cancellation descriptor already mapped to the current checkpoint context.

For retained undo/redo across truncation, persist current-checkpoint-context cancellation handles containing the mapped reversible changes and the dependency/ownership witnesses required by §8.2. Prepare them while the necessary context is still present, either incrementally as commits arrive or during checkpoint construction. A checkpoint can alternatively carry the bounded suffix required for a particular handle, but may not advertise support while silently requiring the discarded prefix. Do not call a reference to a deleted log entry a complete handle.

Exact backwards traversal from state V with retained complete transitions `T_V, T_(V-1), ...` uses their inverses in reverse order without reconstructing earlier snapshots. If those transitions were discarded, historical traversal beyond the retained horizon is unavailable even when current-context undo handles for selected groups remain. Do not conflate selective undo availability with complete archival replay.

Specify separate horizons/limits for late-operation transformation, undo/redo handles, exact historical replay, and deduplication. Keeping data for one purpose may be necessary after it expires for another. Cleanup must not silently break an advertised capability or allow an ancient nonidempotent request to apply twice. Expired context/epoch returns explicit resync or history-unavailable with original work preserved.

Checkpoint installation and prefix deletion are an atomic storage-adapter protocol: write the complete bundle and tail boundary, publish/confirm it durably, only then retire the prefix. Test interruption before and after publication with a fake durable adapter. No database/backend deployment is required. Concurrent accepted work must either be included in the checkpoint's stated cut or remain in the tail—never lost between them.

Undo/redo immediately after checkpoint import must use only checkpoint+tail, without replaying from genesis or regenerating inverse payloads by forward-playback. Schema/operation incompatibility is diagnosed before application. Redo after restart derives from retained actual undo effects, not the original user request.

The storage cost is deliberate: deleted/overwritten data needed for undo must exist somewhere. Self-contained records increase bytes; checkpoints bound loading and context retention, not the information needed for advertised undo. Ordinary byte compression and explicit retention are allowed. Hidden-state records and checkpoint exports obey existing visibility restrictions.

## 9. Anchors and base-aware proposals

Expose a small, reusable anchor-mapping service covering supported structural node references, relative paths/array positions, and text points/ranges. Use the same change/context information as editing, rather than searching for matching text after every change.

An anchor records enough context and boundary affinity to be interpreted. Mapping may return a surviving anchor, multiple surviving ranges, a removed/orphaned target, or a context-unavailable result. A structural target that was deleted must not jump to a different equal-looking object. Text carets may map to a documented deletion boundary; content ranges and node references have distinct removal policies.

For a replacement/rewrite of the referenced content, a correct address is not proof that a diagnostic or agent conclusion is still valid. Support a lightweight read-content/version precondition or return sufficient effects/context for the caller to detect invalidation. Do not implement semantic reasoning or an agent scheduler.

Retain and exercise the existing three-state proposal rule:

```text
A = base read by the author
B = author's proposed result
C = current accepted state
proposal = diff(A, B)
rebased = rebase(proposal, accepted changes from A to C)
```

A proposal can remain unapplied while being rebased; rebasing it must not mutate C. Applying later uses current validation/permissions. A missing A is an explicit unavailable-context/import/review path, not `diff(C, B)`. No dedicated multi-branch store, proposal UI, or document orchestration layer is required.

Anchors, selection, cursors, and presence are not automatically injected into the canonical file. An application may explicitly model persistent comments; the library does not prescribe that schema.

## 10. Existing boundaries that remain unchanged

- Keep codec semantics, effective defaults, structured-output exporters, and browser bootstrap working. This revision is not a provider research or SDK migration task.
- Do not add CodeMirror/ProseMirror adapters, collab plugins, editor undo bridges, IME integration, or a renderer. Keep runtime-facing boundaries adaptable; do not claim the mapping problem is already solved.
- Do not add encryption work. Preserve authorization and homogeneous visibility regions already required. New deleted values, inverses, group records, anchors, and errors must not disclose forbidden data.
- Do not introduce a full database, room deployment, auth service, consensus/multi-writer system, mandatory vector clocks, universal reactive runtime, agent topology, or branch manager.
- Do not replace OT with locks, last-writer-wins, reject-all-on-stale behavior, or CRDTs. Keep the operation family generic; domain buttons remain builders/actions.
- Do not treat the legacy reference repository as the target repository or push/publish without an identified authorized target.

## 11. Assignment and implementation sequence

### Phase A — inspect and establish the actual baseline

Read current instructions and code, record the checkout revision and working-tree status, preserve unrelated work, and run the actual baseline commands. Inspect operation application, table/index semantics, transforms, client pending/acknowledgement handling, history, visibility, and public APIs.

Treat the prior report as an audit guide, not proof. Reproduce suspected behavior with failing tests: duplicate-valued array deletion, both branches of insert/delete text transformation, ranges crossing split/merge, and pending-queue context updates. Identify which capabilities are absent rather than assuming reported file names are still current.

Amend the relevant portions of `SPEC.md`, `ACCEPTANCE.md`, and `AGENTS.md` to reflect this revision. Remove the obsolete optional-undo exemption, review the protocol decisions and documentation, and preserve the unchanged product contract. No full rewrite of unrelated documents or code.

### Phase B — coherent operations and contexts

Fix the request/receipt/context/origin contract in §§5.4–5.8 before building dependent protocol behavior. Repair sequence occurrence addressing and expand text/structure transforms as required. Define batch results, stable tie-breaking, and context propagation. Adopt complete serialized reversible records, transform their undo payloads, implement state-free inversion and sequential composition, and check the numeric profile. Cover all affected pairings and downstream consumers, not only the regression that first exposed the issue.

### Phase C — publication boundary and collaboration

Implement the staging/commit/notification boundary with counted subscribers. Integrate it into the selected forward paired-rebase control profile, with private recovery recomputation. Add the stable snapshot/change-summary boundary and the small headless runtime adapters. Repair dependent pending, immutable sent identities/payloads, scalar-prefix gap handling, acknowledgements, exact terminal receipts, duplicate delivery, and rejection/recovery behavior. Test host-independent checkpoint continuation with the fake atomic storage adapter, not a new deployment stack.

### Phase D — history and address services

Implement grouping, safe unsent coalescing, local and collaborative undo/redo, targeted own-group cancellation, in-flight handling, retained backwards replay, and version-aware anchors. Exercise a rebased agent proposal through the existing diff/protocol path. Ensure these capabilities use real public APIs and survive remote changes and a fresh-process checkpoint restore. Persist current-context cancellation handles and test prefix truncation and duplicate receipts.

### Phase E — full evidence and cleanup

Expand the deterministic and generated suite, run the multi-client scheduler and negative controls, update headless examples/API usage, and remove superseded code and exports. Run the existing complete check pipeline and extended property budget. Report exact executed commands/results, observed failures and fixes, real limitations, and unexecuted external checks.

These phases are an implementation order, not permission to stop after diagnosis. Choose delegated internal details explicitly, write expected behavior first, implement, and proceed without repeated owner approval of internal types. Do not weaken mandatory outcomes or declare an absent capability complete as a documentation-only limitation.

## 12. Acceptance, quality, and final evidence

`OT_REVISION_ACCEPTANCE.md` defines 54 revision scenario families R01–R54. Integrate them into the actual acceptance inventory alongside strengthened baseline scenarios. They are not one-to-one requirements for new operation names or files. Multiple meaningful tests per family are expected.

Tests use the real library, independently specified expected results, public API consumers, deterministic clocks/IDs where needed, and synthetic data. Generate dependent operations in their actual successive states rather than mislabel sequential work as shared-base concurrency. Run bounded fixed seeds in normal CI and expose a larger reproducible budget. Minimize and preserve counterexamples.

Retain Bun/TypeScript strict checks, pure-core portability, lint/file-size discipline, Knip/dead-code checks, formatting, ESM/declaration build, and the safe clean command. Use the repository's actual tested tool versions and lockfile; do not reintroduce starter version assumptions. Do not add blanket ignores, export dead helpers to satisfy checks, or game test inventory with empty assertions.

Completion requires working code, updated contract/API examples, baseline and revision assertions, fresh-process reversible-record/checkpoint tests, identity/context/receipt and arbitration tests, backward/forward history tests, counted two-phase/runtime-flush tests, and multi-client evidence. Green test counts are not a universal OT proof. Missing actual browser/provider access must remain clearly unverified; no editor integration is required here.

Deliver a concise report containing the inspected revision, chosen control/context model, superseded behavior, changed public API, mapping from R01–R54 to real tests, executed results, limits/retention policies, and any verified versus still-unverified runtime evidence. Do not report this handoff itself as an implementation result.

## 13. Source boundaries and why this baseline was selected

The requirements and v3 ordering/deployment decisions are grounded in the owner discussion and the supplied v2 handoff. This update is consolidation, not a new repository audit, provider probe, or external literature review. The references and source-access status below are carried forward from v2, not claimed as freshly verified here.

The earlier review reported that the original NTU FAQ endpoint failed in that environment, while the owner could open it. The accessible copy was reported as labelled 2021-02-25 with copyright 2010–2015. Byte-for-byte identity with the original was not verified. Do not infer that the original is down, current, or obsolete from that access report.

The FAQ distinguishes control from transformation functions (§§2.1–2.5), IT from ET (§2.13), and describes GOT's ordered undo/do/redo (§2.21). Its table lists IT-based Jupiter, Google Wave, and COT. It does not provide contemporary usage statistics. Our selected paired-IT profile is a project decision, not a claim to implement COT or to inherit Jupiter's results. Its undo, rejected transactions, and compound tree operations need their own tested contextual rules.

The v3 clarification explicitly recognizes deterministic coordinator-free/vector designs and one-room deployment constraints. We retain the chosen coordinator/scalar profile for this assignment without claiming it is uniquely correct or horizontally scales one document without coordination. ID-based insertion order is a project policy, not a discovery of actual creation time.

Both rollback/replay and forward integration are legitimate. Forward paired integration is chosen for its explicit context/queue contract and direct mapping of incoming work to the current view, not a claim that inverse use inevitably triggers render or is always slower. Recompute-on-recovery stays permitted. Keeping every production strategy configurable is not required.

Read only the relevant source portions; this is not a new exhaustive literature task. External code remains a reference, not a dependency or license to copy. Inspect actual versions if adapting code.

- [F1] Original FAQ: <https://www3.ntu.edu.sg/computing/staff/czsun/projects/otfaq/>
- [F2] Accessible FAQ copy: <https://www.scribd.com/document/1074500376/OTFAQ-Operational-Transformation-Frequently-Asked-Questions-and-Answers>
- [F3] CodeMirror collaborative receive/rebase reference: <https://github.com/codemirror/collab/blob/main/src/collab.ts>
- [F4] ProseMirror undo/apply/remap/redo reference: <https://github.com/ProseMirror/prosemirror-collab/blob/master/src/collab.ts>
- [F5] ProseMirror history/grouping reference: <https://github.com/ProseMirror/prosemirror-history/blob/master/src/history.ts>
- [F6] JSON0 retained old values and invert API: <https://github.com/ottypes/json0>
- [F7] Text composition caveat: <https://github.com/ottypes/text-unicode/blob/master/NOTES.md>
- [F8] ShareDB per-component versus whole-batch notifications: <https://share.github.io/sharedb/api/doc>
- [F9] MobX actions/reaction boundary: <https://mobx.js.org/actions.html>
- [F10] MobX lazy computed values: <https://mobx.js.org/computeds.html>
- [F11] Stable external-store snapshot contract reference: <https://react.dev/reference/react/useSyncExternalStore>

F8–F11 motivate explicit publication versus evaluation boundaries; they do not mandate those frameworks. Checkpoint cancellation handles, the application composition-policy boundary, and the exact serialized record contract are this assignment's requirements, not assertions that those sources specify this library.
