# ml-collab-codec — behavioral specification

**Version:** implementation handoff 1.0, 2026-09-22, amended by OT revision v3, 2026-09-24,
and by the remediation handoff (`ML_COLLAB_REMEDIATION.md`), 2026-09-27.  
**Status:** implemented; section 18 records the v3 operation/collaboration/history decisions and
section 19 the remediation contracts, which supersede the rows they name.  
**Language/runtime:** TypeScript; Bun for development and tests.

This document consolidates the two supplied Russian handoffs and subsequent owner
instructions. It replaces those drafts for this implementation. In particular,
source-spelling distinctions between an omitted optional field, null, and an explicit
default are **not** a required agent capability. See section 3. Technical choices
still delegated to the implementing agent are identified in section 17.

## 1. Purpose and boundaries

Create a small reusable library for schema-defined structured documents. A document
has a compact, human/agent-editable HTML-like tagged representation and equivalent
JSON. The library provides parsing, serialization, validation, addressing, common
changes, diff, and optional collaboration using structural and text OT.

Docong is the first consumer, not the library's domain. Customer, payment clause,
Doczilla variable, animation scene, card, and game rule belong to consumer schemas
and adapters. The core must not know these concepts. At least two unrelated domains
must exercise the same generic mechanism; the required examples cover rich text,
numeric board edits, and a game with restricted visibility.

The local saved document is self-contained. In-memory JSON is another representation
of its content, not a hidden competing authority. Local open/edit/save requires no
room, server, database, operation history, principal, or running agent. A standalone
JSON export is also permitted. Never keep independently mutable hidden JSON and text
and reconcile them implicitly.

Agents may freely edit source files, replace fragments, or use helper APIs. Changes
do not have to originate as protocol operations. Parse, validate, and diff are
available after arbitrary edits. Shared-room changes, unlike local file edits, must
pass through the room's agreed application channel.

The clean core excludes rendering, live DOM maintenance, Shadow DOM, canvas, 3D,
network transports, account management, hosting, editor UI, and a universal agent
runtime. A trusted browser-file bootstrap and runtime adapters are small separate
integrations. Do not build a generic React renderer as a prerequisite.

This is a fresh implementation informed by old behavioral decisions. Backward
compatibility with every incidental old behavior is not required. Preserve useful
rules and explicitly document deliberate changes. Do not infer the AnimaticML fork's
implementation merely because its consumer uses text.

## 2. One application schema and a constrained document model

Use JSON Schema as the portable schema contract with a compact set of library
annotations. Zod may be an authoring adapter for an explicitly exportable subset;
it must not become the only way to consume schemas. Avoid a second independent
schema language duplicating ordinary types, object fields, arrays, requiredness,
variants, and constraints.

Choose and document the supported JSON Schema dialect/profile. Annotations cover
component tag mapping, field encoding, ordered/mixed content, stable identity,
reference roles, textual versus atomic values, additive numeric fields, and any
library-specific normalization policy. A schema describes valid states; it does
not by itself define every concurrent-conflict policy.

The first release may define a clear constrained structural model. It need not
support arbitrary object graphs, every JSON Schema keyword, or every conceivable
consumer AST. Not every JSON object is a document node: position, dimensions, and
metadata may be ordinary values. Define the distinction once, not by runtime guessing.

The model must preserve interleaved text and elements. A practical candidate is an
ordered content sequence of strings and component nodes; this does not fix the
public field names. Plain text must not require a service object per character.
Semantic comments/annotations are explicit application data and survive round-trip.
Source-only comments may be omitted by canonicalization if clearly documented; do
not use them as the sole storage for application comments.

Validation must cover local structure and declared additional invariants, including
ID uniqueness, references, and allowed nesting. Trusted application validators are
registered by code, not executed from a file. Unsupported schema features produce
an explicit capability error, not unbounded `any` or a discarded check.

Schema identity/version is part of document interpretation. Pin it or embed the
needed descriptor; changing defaults or type interpretation must not silently change
an old document on reload. Migrations, when needed, are explicit transformations.
The exact portable envelope is a delegated implementation choice.

## 3. Effective values, optional fields, defaults, and errors

### 3.1. Owner correction: application meaning, not spelling selection

For the default application-facing optional-field policy, omission, a null
placeholder, and an explicit declared default are interchangeable when they express
the same application state. The agent must not have to select among them.

For example, with optional opacity defaulting to 1:

```text
{}                  -> effective opacity = 1
{ opacity: null }   -> effective opacity = 1
{ opacity: 1 }      -> effective opacity = 1
{ opacity: 0 }      -> effective opacity = 0
{ opacity: "bad" }  -> diagnostic; no fallback to 1
```

For an optional field without a default, omission and a null placeholder denote a
single unset state. Pick one canonical internal representation. A provider that
requires all keys may emit `T | null`; the adapter resolves null to unset/default.
A provider that permits omitted fields may omit them. No `{present:false}` /
`{present:true,value:...}` wrapper, missing-value sentinel objects, or general
presence-preserving protocol is required or wanted.

Do not add a presence-preserving feature flag just to retain the rejected proposal.
A genuinely meaningful nullable domain value, if introduced by a consumer, must be
explicit in that consumer's value schema; this is not a requirement to preserve
all three spellings in every field or to implement a tri-state framework now.

Required fields do not become optional because another field has a default. Missing
required values and invalid nulls remain errors. Never infer optionality solely from
a `default` annotation. `false`, `0`, and `""` are real values, not generic absence:
normalization must not use JavaScript truthiness.

This policy applies to effective values in complete, authorized data. It does not
mean that a missing member of a patch means reset. A patch changes only its explicit
targets; replacing an authorized complete object normalizes that object. Neither
operation may infer deletion from fields omitted in a partial visibility projection.

### 3.2. Non-mutating validation and explicit interpretation

Keep raw source diagnostics separate from the effective application model. Parsing
and normalization can produce a new interpreted model without mutating the original
source. Validation itself does not silently repair the object being checked.

`default` is already a JSON Schema annotation [J1]. Define how this library applies
it; do not invent a duplicate keyword. Provider transport adaptation and codec
interpretation use the same effective-value rules. Validate defaults when registering
a schema. Null-as-unset is an intentional accepted encoding for optional fields,
not permission to replace arbitrary invalid input with a default.

An invalid number, malformed JSON block, duplicate ID, or unsupported tag must yield
a useful error. A human UI may keep a preview with a visual fallback, but must not
write that fallback over invalid source. An agent receives the same underlying error
in structured form and can retry. Actor type does not alter data correctness.

### 3.3. Semantic equality

Define equivalence over effective persisted content, including node identities,
order, significant text, and declared opaque data. For fields covered by 3.1, compare
after normalization. Equivalent optional/default spellings need not survive lexical
round-trip and should not create semantic diffs or room operations by themselves.
Canonical printing may select one spelling, including omission of default-valued
optional fields. Do not promise byte preservation of arbitrary input formatting.

## 4. Tagged format and legacy behavior

The language is constrained HTML-like notation, not general browser HTML and not
XML semantics by default. Parse it with a small environment-independent parser;
no DOMParser, browser DOM, jsdom, or general-purpose HTML parser is required in the
core. Component meaning and allowed structure come from the schema. Familiar HTML
tag names do not silently acquire browser semantics.

The legacy reference is WebComponentJSONCodec at the pinned revision in REFERENCES.
Its model discards ordinary text during normalization despite recognizing it in the
syntax tree. The new format must not inherit that behavior.

### 4.1. Rules to retain as the starting profile

- Attribute names are case-normalized first. Hyphenated segments map to camel case;
  a leading hyphen can produce PascalCase. `camelCase` becomes `camelcase`, while
  `camel-case` becomes `camelCase`. JSON object keys retain their spelling.
- Attribute equality is equality of normalized property names. The first duplicate
  normalized attribute wins, deterministically. A nonfatal duplicate diagnostic is
  permitted but must not reverse precedence.
- Dot-separated attribute paths address nested properties. Specify ambiguous parent/
  child path collisions; the safe default is an explicit diagnostic, not silent loss.
- JSON data blocks supplement attributes and take precedence over them. Process JSON
  blocks in source order. Merge object/object recursively; replace other colliding
  values with the later value. Arrays are replaced, not concatenated implicitly.
- A `data-property` JSON block targets a declared nested property path. The old code
  accepted object roots only; decide explicitly whether new targeted blocks also
  accept arrays/scalars. Untargeted blocks must describe a property object.
- Nested component order is preserved. Support an explicit multiple-root mode and
  a full HTML container; never silently discard a second root in single-root mode.
- Canonical output has deterministic ordering and escaping. This does not require
  preserving the old serializer's incidental whitespace or attribute spellings.

For all name mappings, serialization must be reversible for the schema profile.
Use a JSON block when an attribute name cannot round-trip to the intended property.
Never lowercase JSON keys or confuse a literal JSON key containing a dot with an
attribute path without an explicitly documented mapping.

### 4.2. Changes required from the old behavior

Preserve ordinary text and mixed-content ordering. Report invalid values and JSON
instead of falling back or skipping them. Do not infer types for unknown strings:
`"0012"` and `"false"` stay strings unless their declared attribute encoding says
otherwise. Unknown tags/fields cause an error unless an explicit opaque/extension
policy allows safe preservation. Do not strip unknown properties as an accidental
side effect of a validator.

Comma-separated primitive arrays are a convenience only when reversible. For an
array containing a comma, empty member, significant surrounding whitespace, or an
ambiguous type, use JSON instead. A serializer must not trade meaning for brevity.

### 4.3. Text and lexical boundaries

Preserve significant spaces, NBSP, newlines, punctuation, and the exact order of
text/inline nodes. Select a schema-aware whitespace policy before formatting code:
pretty-printing must not insert content into mixed-text containers. Inter-element
indentation may be ignored only in an explicitly element-only content mode.
No implicit Unicode normalization. Define treatment of line endings, invalid Unicode,
entities, text escapes, and unsupported entities with tests; do not trim all text.

Required laws, for valid supported models/sources and the normalization in section 3:

```text
parse(print(model)) ≡ model
parse(print(parse(source))) ≡ parse(source)
print(parse(print(model))) = print(model)
```

Source fidelity beyond this semantic contract is optional. Application comments
remain data; ordinary syntax comments are not automatically application annotations.

### 4.4. Diagnostics and robustness

Return stable error codes, a data path, schema path when applicable, source span when
available, node ID when available, and a readable message. Multiple useful errors may
be collected, but no partially valid candidate may be committed by accident. Preserve
the input for correction. Escape HTML-sensitive sequences, including script-closing
payloads. Prevent prototype pollution through path/key handling. Apply explicit size,
depth, operation-count, and resource limits; exceeding them is an error, not truncation.

## 5. Browser container and rendering boundary

A serialized file can contain a trusted application-bundle reference and its document
payload. The browser bootstrap passes the original data to the codec/application.
Do not make browser-repaired DOM the authoritative document representation. Choose
and test a narrow HTML-safe canonical profile or a lossless inert payload container.
Do not claim every string accepted by the custom parser has identical HTML parsing.

Do not execute scripts from an untrusted imported document. Bundle registration and
launch trust are application/host policy. A parser must not fetch external resources
or execute code just because a file declares it. Ordinary data scripts are data only.
Test both browser bootstrap and nonbrowser decode using the same payload, especially
`</script>`, `<`, `&`, quotes, and mixed text. No duplicated editor bundle per file.

Live DOM/Shadow DOM rendering, canvas/3D rendering, UI selection, hover, highlights,
and presence remain outside persisted semantic content. Embedded assets or asset
links need an explicit portability policy. DOCX/DOTX compatibility is a consumer
adapter concern; do not hide an old document package as a competing source of text.

## 6. Identity and addressing

Distinguish node identity, position, relative subaddress, and base context.

A stable node ID names a persisted structural object independently of its current
position. A position names an insertion point or child index in a particular state.
A relative subaddress names a field, un-ID'd child, or text offset inside an owner.
Base context identifies the state against which an edit was formed.

Use stable IDs at useful schema-defined structural boundaries, not automatically
at every JSON object, every depth, or every character. Candidate boundaries include
paragraphs, blocks, cells, semantic objects, board shapes/groups, and scenes. Plain
metadata objects and simple inline/text fragments can remain relatively addressed.
Compare candidate granularities on the fixtures and record the chosen v1 policy.

An externally convenient address may be:

```text
stable owner ID + relative field/content path + base context
```

The wire engine may use another tested internal form. Stable IDs do not eliminate
index/offset transforms. Resolve a stale address in its base, not in the current tree.
IDs do not force whole-node replacement or conflict granularity. Different IDs do not
prove independence: ancestors, insertion positions, references, and invariants matter.

Move preserves IDs. Copy allocates new IDs according to a recorded internal-reference
policy. Split/merge choose which IDs survive before implementation. Duplicate IDs
are diagnosed, not randomly repaired during parse. Do not reuse a deleted identity
for an unrelated object or generate new IDs on every load. Creation may receive an
injected allocator; decoding remains deterministic. A domain ID such as a variable
reference is distinct from the structural ID of its containing node.

## 7. Common change algebra and transactions

Support value changes, structural insert/delete, identity-preserving move, fine-grained
text edits, and numeric delta. This is a set of semantic capabilities, not a fixed list
of public operation names. Choose a compact, explicit wire protocol and transform
matrix before implementation. Domain commands compile into these primitives.

Do not add `createCustomer`, `playCard`, or `createIndependentVariableFromExisting`
to OT. A new button must not add a row to the transform table. Origin/provenance and
author metadata do not determine operational meaning.

Wrap/unwrap, split/merge, and copy can be builders producing common operations.
However, naive delete-and-recreate is not equivalent to a move if a concurrent edit
must follow surviving content. Do not simplify names by discarding identity or
text-range continuity. Add a genuinely general structural primitive if the chosen
model requires it, document why, and cover its pairings.

Transactions apply atomically. Primitive structural well-formedness and final schema
validity are distinct: temporary intermediate states during a container restructure
may violate minItems while the final candidate is valid. Never publish/save a partial
transaction. Invalid final candidates leave the accepted state unchanged.

Trusted validation/authorization hooks operate on the candidate and authenticated
context. File schemas do not carry executable code. Local operation application works
without a server; arbitration and visibility are optional higher-level contracts.

### 7.1. Numeric delta

`add(d)` changes a value relatively. With initial 10, concurrent +2 and +3 result in
15 when the declared number model and final constraints allow it. Commutativity is
not idempotency: duplicate delivery of one transaction must not add twice; a new
transaction with the same delta is a different action.

Adopt these baseline conflict policies: compatible add/add combines; concurrent
set/add on one field conflicts; differing set/set conflicts; setting an already
identical effective value may be alreadySatisfied. Different fields still require
a final invariant check. Do not serialize an invalid candidate just because addition
operations commute mathematically.

Choose an exact bounded integer/fixed-point profile or specify ordered floating-point
behavior explicitly. Do not assume arbitrary JS Number addition is associative [N1].
Reject overflow/invalid numbers or document deterministic replay/reconstruction rules.
The mandatory +2/+3 scenario uses exact arithmetic. Arbitrary user-facing numeric
properties may remain ordinary settable numbers even if v1 deltas use a narrower type.

Diff may infer a delta only for an explicitly additive field or an explicit requested
mode. The change 10 → 20 in an ordinary field means set(20), not automatically add(10).

## 8. Outcomes, invariant arbitration, and conflict policy

Use distinguishable outcomes equivalent to:

| Outcome            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `applied`          | An accepted transition changed the state.                                  |
| `alreadySatisfied` | The requested effect already holds; no additional change is needed.        |
| `rejected`         | The requested effect was not accepted; return a safe reason/recovery path. |

Do not classify a failed effect as alreadySatisfied to disguise lost data. Partially
overlapping deletions can transform to remove the remaining original content.
A batch with some redundant effects can still apply if removing those redundancies
does not change the meaning of the rest of the transaction.

### 8.1. Mandatory collection example

Starting with `[a,b]` and minItems=1, A removes a and B removes b from the same base.
For authoritative acceptance order A then B, accept A, reject B after checking its
candidate, and retain `[b]`. B's target survives; B is not a successful no-op.
For order B then A, the result is `[a]` with A rejected. Both outcomes are legitimate
under their distinct arbitration orders.

If both remove a, the result is `[b]`, with the second removal alreadySatisfied.
That is different from trying to remove the final surviving b.

### 8.2. Other baseline policies

Concurrent delete/replace of a parent versus an edit inside that parent is a conflict:
reject the second incompatible transaction in either arrival order. A later deliberate
deletion based on reading the updated state is not that concurrent conflict.

Move plus an edit of a surviving descendant must preserve both effects. Conflicting
moves of the same node require a recorded deterministic policy; the conservative
baseline is rejection of the second incompatible move. Moves that jointly create a
cycle are rejected at candidate validation. References are checked in the final state.

Whole replacement remains replacement unless an explicit base-aware diff decomposes
it. Do not pretend the replacement's ID reveals which child words should survive.

Reject an entire conflicting transaction, not only the inconvenient primitive,
except for explicitly harmless already-satisfied effects. Retain the rejected local
edit for review/retry. A generic "last writer wins" is not the default answer.

## 9. OT and the authoritative client/server protocol

Use an authoritative order of accepted transactions. A request includes a base context
and a deduplication identity. The authority validates the authenticated request,
locates the base/history, transforms over accepted concurrent changes, constructs a
candidate, checks current rights and invariants, and atomically commits a receipt and
accepted transition. Publish only authorized data. No race between validation and
commit, and no trust in a client-supplied `validated` or arbitrary author field.

A repeated transaction identity with the same payload returns the same recorded
receipt, including a rejection, within the documented retention window. The same
identity with a different payload is a protocol error. If deduplication/base history
is too old, require an explicit recovery path rather than guessing or reapplying.

Clients maintain confirmed state and pending edits. Rebase pending edits when remote
changes arrive. After rejection, restore/recompute from a confirmed base and reconcile
remaining pending changes. Edits depending on a rejected effect are not silently
applied to nonexistent state. Do not blindly apply an old inverse over newer remote
changes. Loss of required base history gives resync/retry with the local intent kept.

A useful diamond property for supported compatible operations on a shared base is:

```text
apply(apply(S, A), transform(B against A))
  ≡ apply(apply(S, B), transform(A against B))
```

This is not the whole proof obligation. Test three or more clients, dependent pending
queues, duplicates, reconnects, and reordered delivery. For rejected/invariant-bound
operations, compare clients under the same authoritative decisions; do not require
invariance under changing the arbitration itself.

Separate sequential composition from concurrency transformation. Equal end-state
application of a composed history does not automatically justify transforming against
that history's composition. Establish the properties actually required by the chosen
protocol; retain history boundaries when a compression identity is unproven [T1].

A pure optimistic-concurrency mode may reject overlaps, but cannot replace required
fine-grained OT. The supported profile must accept the compatible scenarios, not
merely converge by rejecting every remote write. No user-facing lock-management task.

## 10. Rich text and text coordinates

Choose the protocol's text unit before coding. Unicode code points are a recommended
candidate, not an assertion inherited from the old implementation. Document conversions
for runtime/editor offsets. Positions are in decoded content, not entity spelling:
`&amp;` represents one content character. Test Cyrillic, emoji, combining sequences,
and composed emoji. Grapheme-wise cursor motion is an adapter concern.

Select deterministic concurrent-insert ordering and split-boundary affinity. Baseline
text deletion removes original content, preserving concurrent insertions unless a
separate explicit policy says otherwise. For `abcd`, deletion of original bc concurrent
with insertion X between b and c yields `aXd`.

Required rich-text scenario:

```text
Base:       Term 10 days.
A:          wrap 10 in an emphasis element
B:          replace the original 10 with 15
Result:     Term <emphasis>15</emphasis> days.
```

The public syntax may use a custom-element tag such as `doc-emphasis`. Preserve both
effects, regardless of whether internal strings split into multiple segments. An OT
engine for fixed strings alone does not satisfy this contract. Also test container
split/merge and range reparenting with concurrent text edits, including exact boundaries.

Do not assign IDs to every character as the automatic solution. Select a coherent
text/structure representation and general operations that retain the needed mapping.
An explicit unsupported advanced feature is honest; rejecting the required compatible
rich-text cases means the implementation is not complete.

## 11. Diff, snapshots, history, provenance, and presence

Diff works from two snapshots without a history. It reports values, text, structure,
order, properties, and references; stable IDs improve matching. Do not confidently
identify similar anonymous blocks as a move without sufficient evidence. Ignore
attribute-order/source-formatting noise and equivalent default spellings, but preserve
significant whitespace, style data, identity, and opaque content.

For valid supported A and B, apply(A, diff(A,B)) ≡ B. This synthesized transition is
not the actual history or intent of the author. It is deterministic within a documented
profile; it need not be the globally minimal edit sequence.

To combine a free agent edit with concurrent work, retain A (the read base), derive
B (the agent's result), and transform diff(A,B) over accepted A→C changes. Do not
compute diff(C,B), which would attribute the human's changes to agent deletions.
Without A or equivalent context, use an explicit replacement/import/review path.

A snapshot is self-contained. Optional history records accepted transitions and
sufficient replay data; it is not required to open the document. Replay requires no
consumer UI. Collaborative (selective) undo/redo of the caller's own groups is
required by OT revision v3 (section 18.9); it is never a raw old inverse or a diff
back to a snapshot. Ordinary local transaction rollback is required.

Optional provenance records actual source identity/version/hash/range only when
known. Do not invent history by similarity, or require an agent to import an entire
source document merely to manufacture provenance. Source materials become recoverable
only if genuinely retained or referenced immutably.

Presence, cursors, recent-read/write indicators, and highlights are ephemeral adapter
features. Observed agent activity is not knowledge of what the agent is thinking.
Offline file edits without an observed channel do not imply live presence.

## 12. Structured-output provider profiles

Support export for OpenAI, Gemini, and Anthropic through versioned capability profiles.
Do not assume full JSON Schema support, provider interchangeability, or that successful
SDK invocation means every original constraint was enforced [O1,G1,A1]. Use one source
schema, not three hand-maintained application schemas.

Separate: (a) provider acceptance of a schema, (b) generation-time constraints, and
(c) validity of the decoded document/transaction in its current application context.
Rights, references, unique identities, and joint invariants always need local/authority
checks. A conforming output alone is not permission to apply it.

Export must return the request schema, profile identity, any representation adapter,
generation-enforced constraints, runtime-only checks, incompatibility diagnostics,
and relevant complexity limits. These are requirements for observable information,
not prescribed TypeScript property names. Distinguish representation mode (native or
projected) from guarantee coverage (generation versus runtime validation).

Unsupported features are either explicit errors or explicitly moved to runtime
validation with a report. Do not silently weaken to any/unbounded JSON, stringify a
tree and call it native structured output, or truncate to fit a budget. Remove library
annotations from a provider schema only when their function remains accounted for
in the adapter/runtime contract. Nonportable Zod transforms also need an explicit
error or registered runtime-only check [Z1].

### 12.1. Optional values

Use the section-3 simplification. Optional values can be nullable on providers that
require every property, then normalize to the same effective default/unset value.
Do not generate presence tags. Compare decoded semantic content, not lexical missing/
null/default distinctions. Preserve meaningful `false`, `0`, and empty strings.

### 12.2. Recursive documents

Do not restrict the persisted document's depth just because a provider cannot express
the same recursive schema. Select a documented strategy: native tree where supported,
a bounded fragment with a checked limit, or a typed flat node-table projection with
references. The first release must demonstrate a recursion-compatible export path
and a typed nonrecursive projection path for the selected incompatible profile.

A node table preserves mixed-content order, component types/properties, and stable
IDs. Temporary wire references are not mandatory persisted node IDs. Decode verifies
roots, reference existence, acyclicity, single-parent tree structure, and allowed
nesting. Never materialize opaque/hidden absence as a deletion or a default. Any depth,
size, optional-property, or union budget is explicit and versioned.

### 12.3. Evidence and live probes

Store a documentation-derived capability matrix with retrieval date, provider,
model/family, and API mode. Recheck official documentation when implementing; source
handoffs are not live API evidence and provider limits are not timeless constants.

Provide opt-in live probes recording model, date, API mode, SDK version if used, hash
of the actual sent schema, HTTP outcome, finish/refusal status, and local validation
result. Include direct-schema checks so SDK rewriting is not mistaken for native
acceptance. Missing credentials mean skipped, not passed. Refusals, interrupted JSON,
and schema errors never trigger document application. Do not call paid APIs by default.
Do not place private document values in provider probes or examples.

## 13. Hidden data and restricted replication

Visibility is a delivery/authorization contract, not a new domain OT operation.
A participant must not receive a full snapshot/history containing secrets it cannot
read. Hiding a value in the UI or removing it from a later snapshot cannot revoke
information already delivered.

For full state S and authorized view P_u(S):

```text
apply(P_u(S), update_u) = P_u(S_after)
```

An authorized update is not necessarily the full server operation with fields removed.
Filtered arrays have different indices; old values, inverse data, diagnostics, diffs,
provenance, prompts, schema enums/defaults, receipts, and logs can all carry secrets.
Define the exposure surface and test it. Avoid leaking existence as well as content
when the selected policy requires it.

The required first profile uses explicit regions/subdocuments with homogeneous
permissions. Within an accessible region, use the ordinary shared protocol. Cross-region
actions are authorized and atomic at the authority. An opaque principal/capability is
provided by the host; no built-in user database is required for the library.

Arbitrary per-field filtering of one shared tree is not claimed by this profile. It
would need its own address, view-version, permitted-write, and projection contract.
In particular, hidden/unknown fields are not section-3 null placeholders: replacing
a visible parent must preserve hidden content by a valid scoped-write contract or
reject the request. A partial snapshot is never a complete replacement candidate.

Required example: public table, two private hands, and an observer. A trusted
application action "play card" checks rights and moves/reveals only the permitted
card atomically using common primitives. Other cards, prior secret values, and private
history do not leak. Revocation/current-right checks happen at commit, not only read.
Previously delivered information cannot be made unknowable; document that boundary.

A full authorized export is self-contained and can reopen without a server. A
participant export is explicitly partial and cannot silently erase unseen regions
on import. Ordinary nonsecret local documents still have no principal/server requirement.

For tests, compare accessible payloads/errors/selected metadata between full states
differing only in forbidden secrets under the same allowed action and observable
schedule. Do not claim complete protection against timing/traffic analysis from this
bounded non-disclosure property.

## 14. Security, portability, and practical limits

Schemas and documents are data. No eval, executable validator expressions, or functions
loaded from untrusted JSON. Use own-property-safe mapping, no prototype pollution,
no untrusted bootstrap execution, and explicit parser/operation resource bounds.
Check authorization against actual current state. Keep diagnostics safe for the caller.
Only synthetic public fixtures; do not publish private contracts or unrelated sources.

Core code lives under `src/core` and compiles without DOM, Node, or Bun ambient types.
Runtime adapters are isolated under `src/adapters` or explicitly documented equivalents.
Development on Bun does not imply the library needs Bun in a browser or Node consumer.
Actually execute built-package samples in Bun, Node, a real browser, and a worker-like
environment before claiming support. A successful browser bundle alone is not runtime
proof. Network-dependent validation is forbidden by default in the clean core.

Measure representative small and large documents, adversarial depth, and long text.
Avoid repeated whole-document copying for every character when it makes the intended
use impractical. Record resource/performance observations, not fabricated targets or
universal complexity guarantees. Optimization must preserve the behavioral contract.

License choice remains open. Keep the package private until selected. Reusing code
requires retaining its actual license obligations; a from-scratch rewrite is not a
license to copy arbitrary implementation text without review.

## 15. Testing obligations and completion

`ACCEPTANCE.md` provides 60 required initial scenarios. They are a starting basis,
not the entire test suite. Implement unit, fixture, public-API, property, protocol,
package, runtime, and optional live-provider tests. Minimize counterexamples and
save reproducible seeds. Keep baseline expected outcomes independent of implementation.

Properties include round-trip/canonicalization, effective-value normalization,
apply/diff equivalence, ID preservation, atomic failure, valid accepted states,
compatible-operation convergence, multi-client convergence under fixed arbitration,
deduplication, replay, and the restricted-view delivery law. Select algebraic
identities actually required by the chosen protocol; do not invent invalid ones.

Mandatory negative controls must fail when an engine rejects all concurrent edits,
drops an insertion, applies a delta twice, silently defaults invalid input, or exposes
a forbidden old value. Passing convergence tests by refusing all useful work is not
acceptable. Tests with no product assertions do not count toward completion.

Required runnable examples are headless sufficient: mixed rich-text operations,
a board using numeric deltas, and a hidden-hand game. Include the whole local path:
schema → source/JSON → free and addressed editing → diff → concurrent application →
save → reopen without a room. A minimal browser bootstrap demonstrates the container
contract; no polished editor is required.

Completion is the working profile and evidence, not a declaration that "the schema
will generate it all". `bun run check` must pass with no baseline placeholders and
with actual package/runtime/example checks wired in. Report unexecuted live probes
as skipped and optional unsupported behavior accurately. Do not silently reduce the
required scope to parser-only or optimistic concurrency.

## 16. Deliberate non-goals for the first implementation

No universal renderer, Shadow DOM synchronization, canvas/3D framework, production
backend deployment, auth service, agent orchestration runtime, arbitrary hidden-field
OT, DOCX/DOTX engine, lexical-preservation editor, or exhaustive JSON Schema support.
These exclusions do not remove the required generic OT, rich-text restructuring,
deltas, collaborative undo/redo (section 18), typed provider export, or restricted
regions. Revision v3 additionally excludes CodeMirror/ProseMirror adapters,
renderers, encryption, vector-clock/multi-writer control, consensus, and production
deployment systems.

## 17. Delegated implementation decisions

Record concrete choices here before implementing their dependent protocol/tests.
Do not turn each choice into a separate long design document or seek owner approval
for routine technical decisions. New product semantics remain a separate question.
These entries are genuinely unselected in the sources, except where a baseline above
already supplies the required behavior.

| Decision                         | Required record                                                        | Initial status                                        |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Structural model and annotations | Minimal supported shapes, mixed-content mapping, schema dialect        | Select before codec tests                             |
| Canonical values                 | Internal unset/default form; optional null decoding; no presence union | Policy fixed; representation delegated                |
| Text whitespace/coordinates      | Content modes, offset unit, line endings/entities, split affinity      | Select with Unicode/round-trip examples               |
| ID granularity                   | Addressable roles, allocator, copy/reference, split/merge rules        | Compare fixtures, then select                         |
| Operation wire format            | Primitive algebra, addresses/base contexts, transform pairings         | Select before OT implementation                       |
| Numeric model                    | Delta range/precision, overflow, normalization/replay rules            | Exact mandatory examples; profile delegated           |
| OT implementation                | Own or evaluated reusable core, required laws and limitations          | References do not preselect a dependency              |
| History bounds                   | Base retention, receipt retention, retry/resync behavior               | Select and test                                       |
| Unknown data                     | Strict rejection and any explicit opaque extension escape hatch        | No silent loss                                        |
| Provider profiles                | Model/API scopes, limits, native/projected routes, evidence dates      | Implement and verify, not assume                      |
| HTML envelope                    | Trusted bootstrap, lossless data handoff, schema/bundle versioning     | Select and test in browser                            |
| Region contract                  | Authority, handles/references, rights checks, safe receipts            | Homogeneous regions required; fine filtering excluded |
| Packaging/license                | Public entry points, builds/types, publication license                 | Private until release choice                          |

Add implementation results and short reasons to this table or adjacent paragraphs.
Do not mark a choice "verified" without the corresponding runnable tests.

### 17.1. Implemented choices (v1)

| Decision                   | Choice made                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why / evidence                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Structural model           | `ComponentNode { id?, tag, props, content? }`, `ContentItem = string \| ComponentNode`. Schemas are JSON Schema 2020-12 manifests compiled by `defineDocumentSchema` (§19.1; the compact profile is an import format). The operational table holds rows with ordered `children` id lists; text runs are `#text` rows; `$root` keeps the document's own id in `rootId` (§19.2).                                                                                              | C01/I01; R01–R09; MR01, MR10.                                                                                                    |
| Canonical values           | Unset is represented internally by key omission (never a stored `null`). Effective-value normalization lives in `src/core/normalize.ts` and is reused unchanged by the codec (C02/C03) and by provider decode (S03) — one function, two callers.                                                                                                                                                                                                                            | Matches SPEC §3.1 exactly; C03/S03 assert identical outcomes from omission/null/explicit-default.                                |
| Attribute/property naming  | Retained the legacy hyphen⇄camelCase mapping verbatim (`src/core/naming.ts`); reversibility checked by round-tripping the derived attribute spelling back through the same function before using it in `print` (C09/C10).                                                                                                                                                                                                                                                   | Required "must be reversible for the schema profile" rule (§4.1); a property that doesn't round-trip falls back to a JSON block. |
| JSON-block precedence      | All attributes processed first into a merge tree, then all `<script type="application/json">` blocks merged on top in source order (recursive object merge, array replace); `data-property` targets a dot-path.                                                                                                                                                                                                                                                             | Matches §4.1 exactly; C07/C10 assert JSON always wins regardless of source position.                                             |
| Whitespace/content modes   | Three modes on `ComponentSchema.content.mode`: `mixed` (verbatim), `element` (whitespace-only text dropped, non-whitespace text is an error), `none` (no content). No implicit Unicode normalization; text offsets are Unicode code points throughout (`[...text].length`, never UTF-16 length).                                                                                                                                                                            | C13, I03 (emoji/combining-mark offsets), §4.3/§10.                                                                               |
| Split-boundary affinity    | Text inserted exactly at a split point stays with the left (original) run; a split point moves after text inserted at it; a caret anchor chooses by its `affinity`. Two splits of one run at the same point: the lower stable origin is the outer cut.                                                                                                                                                                                                                      | O13, R07, R29.                                                                                                                   |
| ID granularity             | `ComponentSchema.identity: "stable" \| "none"`. Stable IDs are assigned by the schema author at structural boundaries (paragraphs/blocks/cards/etc in the fixtures); plain text runs and un-identified components get **ephemeral** ids from a session-local allocator (`createAllocator`), never persisted (`TableNode.persisted`). Move keeps the id; copy/insert always mints a new one; split/merge mint/drop ids explicitly (`splitText`/`mergeText` ops).             | I01/I02; matches §6 ("not automatically at every JSON object... or every character").                                            |
| Operation wire format      | Superseded by v3 (§18.3) and §19.3: thirteen self-contained reversible primitives (`sdl.ops/2`: `set`, `delta`, `arrayInsert/Delete/Move`, `textInsert/Delete`, `nodeInsert/Delete/Move`, `split`, `merge`, `setTag`), each with a stable origin; the old value-search array removal was removed.                                                                                                                                                                           | R01–R13, R36, MR11.                                                                                                              |
| Transform matrix           | Superseded by v3 (§18.4) and §19.5: a full pairwise inclusion transform over all thirteen primitives, with expansion, origin-ordered ties, and explicit conflict policies, covered by the 13×13 pair matrix.                                                                                                                                                                                                                                                                | MR34–MR38.                                                                                                                       |
| Numeric model              | Superseded by v3 (§18.5): additive deltas use JSON safe integers only (value, delta, and result); anything else is `numericProfile` rejected. Ordinary numbers remain settable.                                                                                                                                                                                                                                                                                             | R12.                                                                                                                             |
| OT implementation          | Superseded by v3 (§18.1–18.8): one logical authority per document, scalar confirmed prefix, paired inclusion transformation, forward rebasing with private recovery.                                                                                                                                                                                                                                                                                                        | R35, R45–R53.                                                                                                                    |
| History bounds             | Superseded by v3 (§18.11): separate transform, deduplication, archive, and undo-handle horizons; unavailable context is an explicit `resync`/`unavailable` result.                                                                                                                                                                                                                                                                                                          | R31, R37–R39, R51.                                                                                                               |
| Unknown data               | Superseded by §19.1: undeclared properties follow the schema's `additionalProperties` at every depth (`false` diagnoses them; `true` or a schema preserves them); undeclared components follow `unknownComponents` (`reject` or opaque `preserve`).                                                                                                                                                                                                                         | C11, MR05, MR08.                                                                                                                 |
| Provider profiles          | Superseded by §19.6: `src/core/provider-profiles.ts` holds dated, sourced profiles whose budgets are labelled `documented` or `internal`; live checks are the opt-in `bun run probe:live`.                                                                                                                                                                                                                                                                                  | S01/S02/S05, MR16, MR18.                                                                                                         |
| Recursive/projected export | Superseded by §19.6: `exportComponentProperties` and `exportDocument` (`nativeTree` or typed `rowProjection`), paired `encodeProviderOutput`/`decodeProviderOutput`.                                                                                                                                                                                                                                                                                                        | S04/S06/S07, MR14–MR17.                                                                                                          |
| HTML envelope              | `src/adapters/browser.ts`: the tagged source is embedded as an escaped `JSON.stringify` string inside `<script type="application/json" id="doc-payload">`, with `</` replaced by `<\/` to prevent premature termination/script injection; extraction is plain string scanning (no DOMParser). Verified by an actual browser load (see delivery notes) as well as C12/Q01.                                                                                                   | C12, Q01 (real browser + Bun + Node + a Node worker).                                                                            |
| Region contract            | A component with `regionOwner` owns its subtree for that string property; `RestrictedAuthority` checks touched nodes and positional lists against the actor's view at admission, runs trusted actions, and delivers per-participant events (§18.13, §19.4).                                                                                                                                                                                                                 | V01–V07, MR31.                                                                                                                   |
| Packaging/license          | Owner selected Apache-2.0 (2026-09-26): `LICENSE` added, `"license": "Apache-2.0"`, public GitHub repository `AnimaticML/ml-collab-codec`. `package.json` stays `"private": true` so nothing is published to npm without a separate release decision. `.bun-version`/`packageManager` were lowered from `1.3.3` to the installed `1.2.5` (the specified version was unavailable in this environment); this is a reproducibility/tooling correction, not a product decision. | —                                                                                                                                |

### 17.2. Known limitations (reported honestly, not silently narrowed)

The v1 limitations recorded here earlier (coarse diff, placeholder provider data, nested
unknown keys, lost root identity) were repaired by the remediation (§19). Current limits
are listed in §19.8 and in `docs/verification.md`.

## 18. OT revision v3: selected control profile and contracts

This section records the implemented decisions for `OT_REVISION_HANDOFF.md` v3 and
`OT_REVISION_ACCEPTANCE.md` (R01–R54). It supersedes the v1 rows noted in §17.1.

### 18.1. Control profile (`sdl.scalar-prefix/1`)

One logical authority per document/history admits requests serially. A request
carries `(documentId, historyEpoch, replica, seq)`, a submitted `baseRevision`, and
its changes. The authority rebases the changes over every retained transition after
`baseRevision` using the same pairwise transform as clients (paired inclusion
transformation; TP1 only is required because every pair is transformed exactly once
in one context), applies them to a private candidate, checks the host `authorize`
hook and trusted `validators` (schema invariants such as `minItems` and `additive`),
and atomically records the transition (if effectful) together with a terminal
receipt. Earlier admitted work is never displaced; acceptance order is not a claim of
real-world creation order. The profile is not a vector/multi-writer design and does
not scale one hot document across independent accepting nodes (§18.12).

### 18.2. Identity, origins, and contexts

- **Replica incarnation ids** are ASCII tokens matching `[A-Za-z0-9._:-]{1,64}`,
  compared bytewise (JavaScript `<` on ASCII code units), never locale-sensitively.
- **Sequences** are JSON safe integers `1..2^53-1`, compared numerically. A
  `SequenceAllocator` persists each allocation before returning it (write-ahead);
  lost state starts a fresh incarnation from an injected generator; exhaustion or a
  malformed stored counter is an `IdentityError`. Cancelled or packed sequences leave
  harmless gaps.
- **Request ↔ origin:** each authored local change allocates one sequence `n`; its
  request id is `(replica, n)` and every primitive it builds carries the origin
  `(replica, n, ordinal)`. Packing a later unsent change into an earlier request keeps
  the earlier request id and each primitive's original origin (`meta.packed` lists the
  absorbed sequences). Rebase, expansion, composition, and inversion keep origins;
  an undo/redo request gets a new request id while its restored primitives keep the
  origins of the contribution they restore.
- **Contexts:** `meta.authoredRevision` and `meta.predecessors` record what the author
  read; `baseRevision` is the context of the submitted bytes; the client's working
  form lives in "confirmed + preceding working forms"; `TransitionEvent.revision` is
  the accepted position only. Group ids are `replica#seq` of the group's first change,
  so two actors never share a group.

### 18.3. Reversible records

Every serialized primitive is self-contained: `set` carries before/after (absent =
unset), `delta` its integer, array/text/node deletions carry the exact removed
values/text/subtree (ids, order, props), moves carry both placements, split/merge
carry node ids, offset, parent, and index. `invertChange` needs no state; composite
inversion reverses order. Before-values and removed payloads are checked preconditions
at apply time (`preconditionFailed`), so a tampered record cannot inject data.
`decodeChanges` is strict: unknown kinds or fields (for example a client `minItems`)
are rejected. Builders (`ChangeBuilder`, `wrapText`, `unwrap`, `splitContainer`,
`mergeContainers`) read their stated context once and apply as they build.
`textReplace` records the insertion at the end of the replaced range before deleting
it, so replacement text binds to the replaced content (this is what keeps O12's
wrap-plus-replace inside the wrapper).

### 18.4. Transformation rules

- Sequences (text code points, array elements, child lists) map positions through
  one concurrent step; deletions are mapped element by element and re-grouped into
  runs emitted highest index first, so an insertion inside a deleted range survives
  and the deletion expands (`abcd`: delete `bc` versus insert `X` → deletions of `c`
  then `b` → `aXd`). Overlapping deletions must agree on shared removed content.
- **Same-gap ties** between genuinely concurrent insertions (text, array values,
  node inserts, move destinations) order by `(replica bytewise, seq, ordinal)`; a
  split continuation always stays glued to its run. Identical origins fall back to
  payload order (only reachable for identical content).
- **Conflicts** (the newer/pending side is rejected, never silently merged): writes
  to the same field with different values; set versus delta; a value write versus a
  write inside or around it; removal of an occurrence another change edits; any
  change that needs a node another change destroyed (and deletion of a subtree that
  another change edited); concurrent moves of the same node to different places; a
  move or deletion of a run that is concurrently split/merged; insertion between two
  runs that are concurrently merged. Equal concurrent sets and equal deletions become
  no-ops (`alreadySatisfied`).
- Move cycles are detected at apply time. Because two individually valid moves can
  form a cycle together, the client integrates transitions through private recovery
  whenever both the incoming transition and its pending chain contain moves (§18.6).
- Expansion is bounded: a deletion splits at most once per concurrent insertion it
  spans; `MAX_TRANSFORM_PRIMITIVES` (10,000) raises `TransformLimitError` instead of
  truncating. TP1 and closure-under-transform-and-inversion are exercised by a seeded
  property test over random documents and multi-primitive changes.

### 18.5. Numeric profile

`delta` applies only to JSON safe integers (current value, delta, and result); a
missing or fractional value, a zero/non-integer delta, or an overflow is rejected
(`numericProfile` or a decode error), never rounded. With `schemaValidator`, deltas
are accepted only on fields declared `additive`. Consecutive deltas compose when the
sum stays safe; collaborative undo of a delta is the negated delta, preserving other
additions.

### 18.6. Client state machine

`Client` keeps `confirmed` (table at `revision`), an ordered `pending` chain, retained
intent, and the materialized `visible` table (always equal to confirmed + live pending
working forms). One request per replica is in flight (`nextRequest`), later changes
wait unsent; editing never waits. Incoming transitions are applied in contiguous
revision order (gaps buffered, duplicates ignored); receipts are processed once the
client has reached their `evaluatedRevision`.

- **Forward path:** the incoming transition is paired through the pending chain
  (each entry advances the incoming form into the next entry's context) and the final
  incoming form is applied to the visible table; `ModelCommit.mapping` is exactly that
  form. An own acknowledgement whose content equals the in-flight working form only
  moves the confirmed prefix (status event, no model commit).
- **Recovery path:** rejection, conflict, a locally doomed in-flight entry, a diverged
  acknowledgement, concurrent moves, or an apply failure rebuild `visible` from
  confirmed + remaining entries. Excluded entries are removed by rebasing later
  entries over the exclusion's inverse; entries that cannot follow become `blocked`
  retained intent. An in-flight entry that conflicts locally is `doomed`: it stays out
  of the visible chain until the authority's receipt resolves it. `getStatus()`
  reports forward/recovery counts as algorithm evidence.
- **Reconnect procedure:** restore from the locally saved `ClientSession` (pending
  entries with their frozen submitted bytes, retained intent, history handles) plus the
  confirmed table at `session.revision`, request every transition after that revision,
  and resend the in-flight request unchanged to recover its retained receipt. If the
  authority answers `resync`, `Client.resync(table, revision, reason)` adopts the fresh
  state and keeps all pending work as `resync` retained intent.

### 18.7. Receipts, revisions, and deduplication

Only an effectful accepted request advances the revision; `alreadySatisfied` (empty
effective change) and `rejected` record terminal receipts at their `evaluatedRevision`.
A content-equal but effectful transition (for example delete-and-reinsert) still
advances and its mapping is delivered on the status channel. The ledger keeps exact
receipts keyed by `(replica, seq)` with the canonical request bytes; the same bytes
return the stored outcome without re-evaluation, different bytes are a
`payloadConflict`, an unknown id at or below the replica's highest sequence or below
an explicit expiry boundary answers `resync` (never a fabricated outcome), and a
replica is bound to the first authenticated actor that used it. Wrong document or
epoch, unknown profile/format, unknown envelope or metadata fields (for example a
vector clock or a presence message), and malformed records throw `ProtocolError`
before any mutation.

### 18.8. Publication boundary and runtime integration

Each public client call is one publication batch (`Publisher`): internal steps stage
privately; one `ModelCommit { previous, next, publicationId, changes, mapping,
cause }` is delivered when content changed, a `StatusEvent` otherwise. Snapshots are
immutable, rows are frozen and structurally shared, and `getSnapshot()` returns the
same object until content changes. `ChangeSummary` lists conservative `candidates`
and verified created/deleted/props/text/children/moved changes; a restore without a
primitive mapping uses a full-resync summary. Subscriber exceptions go to
`subscribeErrors` and never uncommit; writes during delivery are queued and run as
later batches. Headless adapters: `ClassProjection` (two-phase install by node id,
reference resolution, one graph update per commit), `DerivedGraph` (dependency-
indexed lazy derivations over prop/text/children/external inputs, injected
`Scheduler`, synchronous demand, versioned async jobs, cycle diagnosis), and
`createSelector` (identity-memoized functional reads).

### 18.9. Grouping, coalescing, undo, and redo

- `HistoryPolicy` decides extend/start-new; the default `typingHistoryPolicy(1000)` (an
  engineering default) extends adjacent own typing/deletion of the same run within the
  gap, and closes on explicit close, incompatible action, clock regression, or an
  applied remote change. Explicit `beginGroup`/`endGroup` tokens span remote activity
  and several accepted requests.
- `CoalescingPolicy.allow` only permits an attempt: an unsent change is packed into
  the previous unsent request of the same group when `compose` actually simplifies
  (consecutive typing, same-direction adjacent deletion, same-field set chain, safe
  delta sum); otherwise it stays a separate request. In-flight and accepted requests
  are never rewritten. `noCoalescing` keeps every sample (trajectory recording).
- `UndoHistory` keeps, per own group, a current-context undo handle: an own member's
  inverse is prepended, every other confirmed transition rebases the handle. A handle
  that meets an incompatible later change becomes a conflict; when that change was an
  own group's, undoing that group restores the handle (§20). `undo()`/`undo(group)`
  cancels unsent members locally, defers while a member is in flight (and sends the
  compensation once the original's receipt is known), otherwise submits a new request
  `meta.undoOf = group` built from the handle rebased over pending work. The authority
  checks that the group belongs to the same authenticated actor. Redo derives from
  the inverse of the effective undo (`meta.redoOf`). Fresh local work clears the redo
  branch; remote work rebases it. Rejected undo/redo keeps the group and records
  `lastError`. `noRemainingEffect` and `dropped` report contributions that were
  already removed by others; the history keeps `undoLimit` groups (default 100) and
  older groups answer `unavailable`.

### 18.10. Anchors and proposals

`mapAnchor(anchor, changes)` maps `node`, `point` (with `before`/`after` affinity;
deletion collapses to the boundary), `range` (original content only; may become
several segments), and `occurrence` anchors, returning `mapped`, `removed`, or (via
`mapAnchorFrom`) `unavailable`. `anchoredContent` supplies a read-content fingerprint
so address survival is not mistaken for freshness. `proposeEdit` diffs the author's
read base A against B; `rebaseProposal` rebases over the accepted A→C transitions
without mutating C, or returns `contextUnavailable` / `conflict`.

### 18.11. Checkpoints and retention horizons

- `exportCheckpoint(authority, schema, retain)` writes `sdl.checkpoint/1`: profile and
  operation versions, schema identity, document/epoch, revision V, table rows with
  internal handles, the last `retain` complete transitions, and the full receipt
  ledger (receipts, per-replica highest/expiry, group owners). `importCheckpoint` /
  `restoreAuthority(bundle, tail)` fail closed on unknown formats or schema versions
  and replay tail decision records exactly once (by receipt identity and revision).
  Since §19.2 the default retains no transitions and import is strict and bounded.
- Horizons are separate: `pruneTransitionsThrough` (late-transform and archival
  replay), `expireReceiptsThrough` (deduplication; expired ids answer `resync`), the
  client's `undoLimit` (handles live in the client session, already mapped to its
  confirmed revision, so undo survives authority pruning and restart), and whatever
  number of transitions a checkpoint retains for exact backward traversal.
- `AuthorityHost` + `DurableStore` define the host contract: at most one effective
  writer via compare-and-commit on the log position plus an owner generation that
  fences former owners; a losing append reloads checkpoint + tail and re-evaluates;
  checkpoint installation is stage → publish → prune, each step safe to interrupt.
  The port is asynchronous since §19.2.
  Moving a history to a new host keeps its epoch, origins, receipts, and handles.

### 18.12. Deployment boundary and future vector profile

A document's authority is a logical contract, not one process for the application;
different documents are independent. One hot document is not scaled horizontally:
multiple machines serving one history must use the host contract above (exclusive
ownership or shared compare-and-commit). Routing, ownership migration, consensus, and
load balancing are not implemented. A coordinator-free vector/hybrid profile would be
a separate, versioned control contract; requests claiming vector context are rejected
today. Presence stays an ephemeral application channel: it allocates no request ids,
revisions, groups, or checkpoints, and a presence envelope sent to the durable decoder
is refused.

### 18.13. Restricted regions under v3

`RestrictedAuthority(profile, documentId, epoch, table)` wraps an `Authority` whose
`authorize` hook requires every touched node to be public or in the actor's region and
refuses positional edits of child lists that contain another region's children. Trusted
actions build their changes from current state at commit (`submitAction`) and are
deduplicated by request id. `eventsFor(principal)` returns per-participant transitions
forwarded as the original records when the change stays within regions the participant
sees before and after, and otherwise synthesized as a diff between the participant's
projections (so no removed values, inverse payloads, or undo links from other regions
travel), with metadata only for the author and receipts only for the requester. `exportFor` is an
explicitly partial participant export.

### 18.14. Storage and measured performance

`toTable` and every applied change produce a `PersistentTable`: an immutable id → row
index split into hash buckets, where a new version copies the bucket pointer array and
only the touched buckets. A change therefore costs roughly its own size plus a small
constant, not a copy of every row; old versions and published snapshots stay valid and
share untouched rows. Rows are frozen; their `children` arrays are private copies typed
`readonly` but not frozen, because freezing large arrays is expensive and slows later
lookups in JavaScriptCore. Table iteration order carries no meaning (document order is
`children`). Recovery replays pending work against this structure, so it is cheap too.

`bun run bench` measures Word-like documents (~20 paragraphs per page, inline emphasis,
a table every ~3 pages) with schema validation, history, and copy-on-acquisition on;
`reports/benchmarks.md` records medians and p95s with the environment. Timings are
machine-dependent evidence, not a gate.

### 18.15. Superseded behavior, public API changes, and v3 limitations

Superseded and removed: `Op`, `applyOp`, `applyBatch`, `applyOpsSequential`,
`transformOp`, value-search `removeArrayItem`, fractional `keyBetween`/`orderKey`,
the old `Transaction`/`Receipt`/`Client`/`Authority` APIs, `ResyncRequiredError`,
`diffAgainstTable`, address `shiftAddress`/`resolveOwner`/`resolveContentItem`, and
the P06 "undo unsupported" assertion, and (§19) `minimalSplice`, `schemaInvariants`,
`rootMode`, and `CheckpointError`. New public API: see `src/index.ts` and `docs/`.

Limitations of this implementation, not silently narrowed:

- Transform rules were checked against TP1 on generated pairs of multi-primitive
  changes (bounded seeds plus a larger `test:property` budget); finite runs are
  evidence, not a proof. TP2 is not claimed (not needed by the scalar-prefix profile).
- Restricted-region clients work on projections; positional edits of lists that mix
  regions must go through trusted actions. Arbitrary per-field filtering remains
  out of scope (§13).
- The client does not persist itself; applications save `exportSession()` and the
  confirmed table. The durable store and transport are adapters (fakes in tests).
- Transform-time conflicts are conservative for structure (moving or deleting a run
  that is concurrently split or merged, nested deletions of edited subtrees).
- Runtime evidence: Node, Bun, and a Node worker thread are exercised automatically
  (Q01); a real browser (Chromium via `tests/fixtures/browser-check.html`) was run
  manually once in this session and is not part of CI.
- Participant events for reveals and hides are projection diffs; newly revealed anonymous
  content receives participant-local handles.

## 19. Remediation (2026-09-27): repaired contracts

This section records the decisions for `ML_COLLAB_REMEDIATION.md` and its acceptance
families MR01–MR44. Consumer-facing detail lives in `docs/`.

### 19.1. Schema contract and validation

- Schemas are JSON Schema 2020-12 manifests (`defineDocumentSchema`) with local `$defs`
  (recursion allowed) and the annotations `x-additive`, `x-reference`, and `x-encoding`.
  `@cfworker/json-schema` (the only runtime dependency) evaluates assertions; unsupported
  keywords, remote references, other dialects, invalid defaults, and excessive limits are
  registration errors. The legacy compact profile is an import format (`migrateLegacySchema`).
- One recursive effective-value normalization serves every entry point (parse, JSON import,
  standalone validation, provider decode, proposals via the authority, checkpoints and
  bootstraps). Unknown keys follow `additionalProperties` at every depth. Structural and
  assertion diagnostics are both reported, each at the exact member path.
- `x-reference: "definition"` values are unique keys: a duplicate is `duplicateId`.
- The schema-backed authority validates every final candidate incrementally; a seeded
  differential test holds it equal to full validation (MR03).

### 19.2. Codec, identity, snapshots, and hosting

- Printing is lossless for every accepted value (extra and opaque props of every JSON kind)
  and refuses values JSON cannot carry. A document has exactly one root; multi-root and
  fragment APIs return every root or item. `$root` keeps the document's persistent id.
- Checkpoints retain no transitions by default and are imported strictly (rows, root,
  links, cycles, depth, schema validity, contiguous and invertible retained transitions,
  ledger, decision tail); failures construct nothing (`SnapshotError`).
- Join: a bootstrap is state (handles preserved, scope recorded), never a log; `beginJoin`
  subscribes before capturing; `joinClient` integrates the tail once, restores a session
  in its own context (reconstructing it from self-contained records), or reports history
  `unavailable` with retained intent. Sessions carry actor and schema and restore only for
  that actor (MR25–MR33).
- `DurableStore` is asynchronous; `AuthorityHost` serializes work, installs only after a
  committed append, reloads after stale or unknown outcomes, fences former owners at every
  step, and never publishes an older checkpoint over a newer one (MR39–MR40).

### 19.3. Diff

`diffToChanges` retags same-id nodes (`setTag`), diffs props per nested field and arrays
by positional splice, aligns child lists by identity keys with an LCS (a 4-million-cell
budget; beyond it the unmatched middle is replaced while persisted nodes are still moved),
moves persisted descendants out of removed wrappers, and diffs text into separate hunks
(`textHunks`). A differing root id is refused (MR11–MR13).

### 19.4. Ownership and runtime

Acquisition copies inputs; borrowed views are deeply `readonly` in the types (rows are
frozen, nested props and child arrays are not); `editableCopy` gives free-edit copies;
sent envelopes are deeply frozen. Deep runtime freezing is not provided (MR19–MR21).
Async derivations propagate completion to dependents with generation checks; dependency
invalidation and projection re-resolution use reverse indexes; restricted events forward
original records when visibility is unchanged (MR22–MR24).

### 19.5. OT verification

The pair matrix covers all 169 ordered kind pairs at boundary geometries in both origin
precedences against an independent oracle; generated sweeps classify every outcome;
simulated histories include validators, checkpoints, pruning, joins, and restarts; 15
controlled faults in the real source must each be killed (MR34–MR38). An edit addressed to
a run absorbed by a concurrent merge (text edits, a split, or a further merge) follows its
text into the surviving run; identical retags are rejected at decode.

### 19.6. Providers

Profiles are dated with sources, and every budget (depth, properties, union variants) is
labelled `documented` or `internal`. Exports report what the emitted schema enforces, what
is local-only, and the measured size (nullable type arrays count toward depth). Decoding
applies the emitted schema, then the full local contract. Live probes are opt-in and never
print credentials (MR14–MR18).

### 19.7. Distribution and delivery

A pinned commit is consumed by clone, frozen install, build, and a path dependency; this
is tested from a clean clone (MR41). `engines` states the tested runtimes (Node ≥ 20.11,
Bun ≥ 1.2.5). Guides in `docs/` contain executed programs (MR42); benchmarks record medians
and p95s with validation and history on (MR43); `reports/` holds the evidence (MR44).

### 19.8. Current limitations

- One authority per document; no vector-clock or multi-writer profile.
- Anonymous siblings have positional identity in diffs; very long child lists fall back to
  coarse middle replacement.
- Revealed anonymous content in restricted events receives participant-local handles.
- Provider profiles are dated documentation evidence; the opt-in live probes have not been
  run in this repository (no credentials were used).
- Nested props and child arrays are not frozen at runtime; mutation through casts is outside
  the contract.
- Parse, print, `toTable`, full validation, and whole-document proposals are linear scans;
  a keystroke inside a very long text run is linear in that run.

## 20. Causal own-undo repair (2026-10-02)

Reported by the Docong integration against `2e5e75c` (acceptance MR45–MR46): an earlier
own group's handle was mapped over a later own group's transition, became a conflict (a
node deletion over a text insertion into that node; a field restore over a later write to
that field) or lost part of its content, and stayed that way after the later group was
undone. Own groups accepted in sequence are causally ordered; the later one was authored
on top of the earlier one. This was a history defect, not a transform defect: the
transform correctly refuses to delete or overwrite content it does not own.

- **Why anything is replayed.** Undo applies a group's inverse, kept incrementally mapped
  to the current context; normally nothing is recomputed. Mapping is lossy when a later
  change makes the inverse impossible (deleting a run would delete the text typed into it
  later): the result is a conflict with no primitives left, so it cannot be "unmapped"
  when the later group is undone. Recovery therefore keeps the last clean form and
  re-maps it, once, when an own undo/redo has cancelled the obstruction.
- **Recovery log.** When a transition degrades a handle — a conflict, a dropped
  contribution, or a primitive whose content (not only its positions) changed — the
  handle keeps `recovery = { base, from }`: its last clean form and the revision it was
  valid at. The accepted transitions are stored once, in the history's shared
  `RecoveryLog`, own ones tagged with their group and kind (`do`, `undo`, `redo`). Clean
  handles keep nothing extra. Only an own undo/redo triggers a recomputation, and only
  for degraded handles; the reduced view after each `from` is computed once per
  transition and shared.
- **Cancellation.** When an own undo of group H arrives, it is cancelled against H's
  effects in the log, latest first, stopping at H's previous undo; an own redo is
  cancelled against H's latest undo. Removing an effect C carries `inverse(C)` forward
  through the later entries, which come out without C (by TP1,
  `C · X₁…Xₙ · inverse(C)′ ≡ X₁′…Xₙ′`). Each step is verified: the accepted undo/redo
  must begin with exactly that carried inverse (canonical comparison); otherwise
  cancellation stops. An unmatched remainder (effects absorbed before the base) stays as
  an entry. After a cancellation the handle is recomputed by mapping `base` over the
  reduced log; if the result is clean, the recovery is discarded.
- **Ownership is preserved.** Only this replica's accepted undo/redo transitions linked
  to a group cancel anything. Remote transitions — including a remote write that restores
  an old value (R18) — stay in the log, so a collaborator's text inside a created run, or
  a collaborator's write to the field, still yields a conflict. Undo of an earlier group
  while a later dependent own group is still active also remains a conflict; LIFO order
  through the later group is the supported path.
- **Bounds.** There is no fixed transition cap. After every transition the log is trimmed
  to the oldest `from` among handles that can still be used — an active group's undo or
  an undone group's redo; spent and evicted groups release theirs — so it is empty
  whenever nothing is degraded and is otherwise bounded by the retained groups
  (`undoLimit`, default 100). A host may set `ClientOptions.recoveryLimit` to cap the
  retained transitions for memory or session size; recoveries older than the cap are
  dropped and their conflicts become final. If a degraded group gains a new own member
  (an interleaved explicit group), its recovery is dropped as before. The log and
  recoveries are part of `HistoryExport` (`recoveryLog`), so exported sessions keep them;
  sessions without it, or with the earlier per-handle form, load with recovery dropped.
- **Cost.** Typing cost is unchanged from before the repair (measured: three 500-keystroke
  bursts after creating a run). Replaying a recovery took about 5 ms in that scenario. A
  separate pre-existing cost remains: a group's handle keeps one primitive per keystroke,
  so undoing a long typing group maps every other long handle over a long transition
  (quadratic in burst length; about 2.3 s for 500-keystroke groups, same as before).
- **Grouping is separate.** Typing policy and explicit groups are unchanged. The repair
  makes undo work across any boundary (default policy, pause, caret movement, explicit
  segments); an application may still choose larger explicit groups for its own UX.
