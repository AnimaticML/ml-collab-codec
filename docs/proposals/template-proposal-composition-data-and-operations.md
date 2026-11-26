# Native templates: composition, inferred data, and semantic operations

**Series:** `template-proposal-` · **Recorded:** 2026-11-26

**Status:** owner-selected direction and implementation handoff. Implement the
contracts and acceptance outcomes below; this is not a request to reconsider
whether templates belong in the shared document foundation. Public API spelling,
representation details, and implementation order within each phase are delegated.
The proposed capabilities are not claims about the inspected implementation.

## Purpose and boundaries

Provide a reusable module in or immediately alongside this library for composing
existing document elements into persistent, parameterized elements. A composition
encapsulates fixed internals and exposes a typed interface. People and agents can
create it from an existing fragment, bind data, fill it incrementally, repeat it,
and edit its exposed values through the same operations and validation rules.

Templates are first-class elements of native documents. Definitions, occurrences,
bindings, and supplied or partial data remain present after every parameter has
been filled. Authoring, filling, and reading the result are projections of that
state, usable together; they require neither separate artifacts nor a global mode
switch. Producing an ordinary flattened document is an optional, target-specific
export. An export may lose template information if its contract says so; it does
not define the native lifecycle or silently replace the source.

This handoff is self-contained. All examples are synthetic and specified below.
Implementation must not require another application's repository, private files,
a server, an agent session, or credentials. Keep the clean core headless and
platform-independent. Do not introduce a mandatory repository, renderer, execution
runtime, or second collaboration engine.

## Inspected baseline and extension boundary

Baseline: commit `ac61985290b6a8ab4a392961d9cfe70bea5a348d`.
Recheck the relevant contracts when implementation begins.

| Already implemented                                                                                                                                         | Consequence for this work                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Document model and fragments](../documents.md): one schema identity/version and root, component trees, typed JSON properties, internal operational handles | A template can be document data; composition still needs a valid host schema and explicit placement rules.                                        |
| [Schemas](../schemas.md): compiled profiles, allowed nesting, stable identities, definition/reference annotations, effective defaults                       | Reuse this type foundation. Existing schema validation does not implement inline parameter inference or template evaluation.                      |
| [Operations](../operations.md): reversible primitives and builders; atomic application                                                                      | Compile semantic actions to ordinary changes where sufficient. A new user action does not imply a new OT primitive.                               |
| [Collaboration](../collaboration.md): authority admission, additional validators and authorization, rebasing, own-group undo                                | Validators currently inspect a completed candidate and accept or reject it. A general consequence planner or autofix hook is not an existing API. |
| [Runtime](../runtime.md): derived graphs, publication summaries, class projections                                                                          | Reuse dependency tracking for projections and inference; these facilities do not already provide template instances or writeback semantics.       |

Preserve OT revision v3 and the current [integration contract](../design/codec-integration.md).
In particular, retain one logical authority per document, frozen retry envelopes,
stable effect origins, explicit conflicts, and current-context collaborative undo.
The earlier [composition handoff](proposal-world-runtime-composition-and-evolution.md)
already identifies static schema composition, ordinary semantic actions, and the
separation of atomic admission from history grouping. Those mechanisms are the
starting point, not grounds for inventing an incompatible action protocol.

`editableCopy` preserves identities for editing the same document. It is not an
instance-creation operation. `insertNode` allocates anonymous handles but uses
explicit supplied IDs unchanged. New composition support must specify fresh
occurrence identities, internal-reference remapping, and preserved external
references; structural IDs and domain definition keys are distinct.

## Persistent composition and typed interfaces

A definition exposes refined scalar, object, collection, variant, and fragment
parameters. Constraints include required inputs for a complete result, permitted
variants, numeric bounds or units where declared, and allowed fragment content.
Derive portable contracts from the supported schema foundation rather than create
a competing general-purpose type system. Unsupported constraints receive explicit
diagnostics; trusted format validators may supply additional invariants.

Bindings address typed values and content, not string substitution in serialized
markup. An object can bind several nested fields; a collection drives repetition;
a variant selects declared structure; a fragment supplies allowed components.
Expressions have explicit scopes, dependencies, and deterministic, bounded
evaluation. They do not execute arbitrary document-supplied JavaScript, obtain
network data, or produce external effects. Acquisition of data is a separate action.

The native schema must permit unanswered bindings while recording their contracts.
A required unanswered input makes a result incomplete, not an unsavable native
document. Show the missing input and its dependent results; do not invent a value.
Preserve the accepted effective-value convention: omitted optional values, null,
and equivalent defaults normalize alike; `false`, `0`, and empty strings remain
data. Do not reintroduce lexical-presence unions to represent partial completion.
Any explicit unfilled/binding state belongs to the composition schema, not a new
general core value-normalization union.

Composition need not add a physical wrapper in a position where the host permits
only particular children. A definition may describe a valid fragment or several
explicit placements. Specify containment, dependencies, and reference closure;
arbitrary disconnected selections are not automatically supported subtrees.
Derived result nodes must have a reproducible source relationship. Do not maintain
an independently editable hidden expansion alongside the authoritative template.
An edit from the result projection targets an exposed binding, an explicit local
override, or the definition through a declared action; it never silently changes
which of these owns the value.

Reuse of review evidence is tied to the definition, exposed contract, and exact
dependency versions or content identities reviewed. An instance satisfying that
unchanged interface can reuse the checks actually established for the definition.
Changes to fixed internals, refinements, or dependencies invalidate affected
evidence. This does not certify all creative, contextual, or visual correctness.
Changing a shared definition is an explicit update with visible affected instances,
not an implicit reinterpretation of old documents. Persist enough dependency
information for reproducible reopening; diagnose unavailable implementations.

## Inline paths infer one shared semantic model

Use three separate identities:

| Kind                              | Meaning                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Structural occurrence ID          | This particular editable node, field occurrence, or instance in document history. |
| Canonical semantic path and scope | The parameter/entity addressed by all references in that scope.                   |
| Human label                       | Presentation text; it can change or repeat without merging entities.              |

Canonical dotted paths build object structure from inline uses. Resolve all
declarations and uses independently of document order. Within the same scope,
the same canonical path means the same entity, even when a declaration is elsewhere
or appears later. Adding a new property extends the inferred object shape.
Inference uses declared types and typed use contexts, not guesses from labels or
current sample values.

Adding a parameter path changes composition data and its derived contract; it does
not by itself install a new executable component, replace the active document
schema, or create another collaboration authority.

The persisted declarations are authoritative; a symbol table or dependency index
is derived and rebuildable. Do not require a second hidden parameter catalog kept
in sync with inline definitions. Compatible declaration contributions merge into
one semantic contract: object properties combine, matching scalar types retain
compatible refinements, and repeated defaults must agree. Diagnose incompatible
types, impossible refinements, conflicting defaults, and scalar/object collisions.
Do not silently let the first or last occurrence win, or widen a conflict to `any`.
Keep compatibility checks within a documented decidable subset.

Choose and document declaration-carrier rules. Multiple inline sites may contribute
compatible facts, but each editable contract fact and value must have an explicit
persisted owner or an action updating all its carriers. A later explicit declaration
adds compatible facts; it does not create a second entity or silently replace earlier
constraints. Store a bound value once for its semantic entity, not independently in
every display occurrence. Existing `x-reference` uniqueness rules remain intact:
repeated parameter declarations cannot be implemented by emitting duplicate ordinary
domain definitions and disabling their validation.

Autocomplete distinguishes **use existing** from **create new**, presents the
resolved scope/path and type, and diagnoses a requested conflicting creation.
Accepting a fully typed canonical path binds the same existing entity just as
selecting its suggestion does; no extra linking click or confirmation is required.
Creating an independent entity requires a different canonical path in that scope;
creating a duplicate at the same path is forbidden. Identical human labels do not
justify merging. Define canonical segment spelling, escaping, and scope resolution
without relying on fuzzy string matching.

### Example 1: a repeated participant field

Illustrative declarations, not proposed parser syntax or existing API calls:

| Occurrence             | Semantic use               | Declared contribution                    |
| ---------------------- | -------------------------- | ---------------------------------------- |
| `field-a`              | `participant.name`         | string, minimum length 1; label "Name"   |
| `field-b`              | `participant.address.city` | string; label "City"                     |
| `field-c`              | `participant.name`         | same scope and path; label "Participant" |
| `field-d`, added later | `participant.email`        | string; label "Email"                    |

Infer one `participant` object with `name`, `address.city`, and `email`. Filling
`participant.name` with `Ada` updates both name projections while retaining their
different structural identities. A later compatible declaration of `participant`
refines this same object. Giving `reviewer.name` the label "Name" creates no link
to `participant.name`.

**Counterexamples:** declaring `participant` as a number conflicts with its object
uses; declaring `participant.name` as both a string and an integer is not two
independent fields. Missing `email` can remain an explicitly incomplete binding.
It must not erase the definition or prevent saving the native document.

Renaming `participant` to `attendee` is a semantic action. It updates applicable
declarations, references, bound data paths, expressions, and dependent metadata
atomically in the affected document. Renaming its human label does none of this.
A collision with an existing path requires a defined merge action or rejection.
External references require an explicit version/update contract; there is no
implicit transaction across documents.

## Collections, scopes, and structured repetition

Collection declarations introduce item scopes. A path inside an item resolves in
that item; an external reference must explicitly identify its collection/item
context. Items carry persistent identities independent of array position, display
label, and mutable business fields. Reordering retains identity and bindings.
Insertion creates new identities; duplication follows a declared data/reference
policy. A stable item key maps repeated occurrences back to their definition and
data across reevaluation, saving, and reopening.

### Example 2: repeated cards with variants and a fragment slot

The synthetic format has `board`, `card`, `label`, and `note` components. A
`TaskCard` definition fixes a card containing a title label and an optional note
slot. Its interface is `title: string`, `kind: task | milestone`,
`points: integer >= 0` for tasks, and `note: fragment<label | note>`.
The milestone variant excludes task points through an explicit variant contract.

A board repeats that definition over `work.items`. Inline title and kind uses in
the repeat body infer properties of its item model; adding a note use extends that
model. Two items with stable keys `item-a` and `item-b` may both display "Prepare".
They remain separate items. Two uses of the title path within `item-a` share its
value; the title in `item-b` does not share it. Moving `item-b` before `item-a`
preserves the cards' occurrence identities and each item's data.

The composition module evaluates binding, variant selection, and repetition.
The host format defines where cards may occur and how they are arranged. Missing
points on a task produce an incomplete result; an unsupported fragment is rejected.
Conditionally excluding a component must not leave an unnoticed dangling reference.

**Counterexamples:** recreating all cards on every array edit loses occurrence
identity; using the current array index as the item key attaches edits to the wrong
card after a reorder. Wrapping a restricted child position in an arbitrary generic
element can violate the host schema. Copying IDs or all identifier-looking strings
without a reference policy is not valid instantiation.

## Semantic actions and deterministic consequences

A user- or agent-visible action expresses one meaningful change: filling an
object, creating an instance, renaming a path, moving scheduled items, or editing
a definition. It may compile to one primitive, several primitives, or a sequence
of requests during a coalesced gesture. Human and agent entry points use the same
action contracts; source edits and direct primitive edits remain possible.

Implement this pipeline:

1. Resolve the intent, targets, base context, policy, and relevant dependencies.
2. Plan requested edits and the deterministic consequences selected by that policy
   against a private candidate. Include declared autofixes in this plan.
3. Expose the complete effect list and provenance: requested versus consequent
   changes, responsible rules, dependencies, affected entities, and diagnostics.
4. Validate the final candidate without mutating it. Authorize every affected
   target, including consequences, rather than only the initial selection.
5. Submit interdependent effects as one atomic request where required. After
   rebasing, authority admission checks the resulting candidate, mandatory
   invariants and captured action scope/dependency preconditions again. A valid
   tree alone does not prove that a concurrent edit preserved the action's intent.
6. Publish only an accepted complete transition; record its actual effects as the
   meaningful history unit. Preserve rejected intent and diagnostics for review.

An ordinary action can already select a documented policy; this does not require
a confirmation dialog for every edit. The plan must nevertheless be inspectable
by humans and agents before acceptance and attributable afterwards.

Autofix is a declared intended consequence, not an arbitrary repair search. Rules
must specify their inputs, affected scope, version, and deterministic behavior.
Use a deterministic dependency order, or a bounded fixpoint with idempotent rules,
cycle/nonconvergence diagnostics, and explicit work limits. No clocks, randomness,
network results, or hidden state may change a repeated plan unless captured as
explicit inputs. If completion, authorization, or final validation fails, accept
zero changes. Do not publish an invalid state and repair it in a later subscriber.

Validation remains non-mutating. Direct/raw edits must satisfy the same mandatory
invariants; bypassing an action UI is not permission to leave an inconsistent
document. Raw edits either provide valid consequences, select a declared planning
policy, or receive diagnostics. Do not silently guess missing intent.

The baseline can submit an already planned complete changeset and reject a stale
invalid result. Do not pretend it has a generic intent-replanning admission hook.
If rebasing invalidates a plan or its captured assumptions, retain intent and
explicitly replan under its authorized policy or report conflict. If existing
admission cannot express the required precondition check, extend its public
contract explicitly; do not claim an existing generic replanning hook. Changed
effects remain reviewable. Never
alter a sent envelope, change retry bytes, or append undisclosed server-side fixes.
Any additional API must preserve these protocol guarantees and prove its need.

One history group can span multiple requests; it does not make them atomic.
Each accepted request must independently satisfy required invariants. Undo/redo
uses the recorded approved effects with the existing current-context transforms;
it does not rerun expressions against changed external inputs, recompute unstable
fixes, or replay side effects. Unrelated concurrent changes survive. Incompatible
later changes produce the existing explicit conflict outcomes.

### Example 3: shifting an ordered schedule

The synthetic format stores ordered items with `start` and positive `duration`,
measured in integer ticks. Its invariant is non-overlap in stored order. Initially:

| Item | Start | Duration | End |
| ---- | ----: | -------: | --: |
| A    |     0 |        4 |   4 |
| B    |     4 |        3 |   7 |
| C    |     7 |        2 |   9 |

The action moves B to start 6 using the declared policy "keep durations; push only
following overlapping items forward." The plan changes B from 4 to 6 and C from
7 to 9. It leaves A unchanged. Validate and accept both writes atomically; show C's
shift as a consequence of the chosen policy. Undo reverses both recorded effects
as one history step while preserving a collaborator's unrelated label edit on A.

**Counterexamples:** publishing B alone creates overlap; a postcommit listener
moving C breaks atomicity and attribution. A different policy that trims B is not
an interchangeable autofix. If C is protected, the whole action fails. If a
concurrent edit makes the rebased result invalid, reject or explicitly replan;
do not erase that edit or silently invent a new scheduling policy.

## Implementation phases and acceptance

Implement through the existing repository workflow. Record new behavioral cases
in the canonical acceptance/specification documents before marking them complete.

| Phase                                  | Required result and meaningful acceptance evidence                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Native representation and interface | A synthetic document retains definition, occurrences, bindings, and partial data through tagged-source/JSON round trips. Fully filling it retains template elements. Author/fill/result projections use the same state. Open, edit, save, and reopen locally without history or a server.                                                                                 |
| 2. Semantic paths and inference        | Example 1 passes with declaration order permutations; adding a property extends one object; labels do not merge entities. Conflicting carriers produce located diagnostics. One rename updates declarations, expressions, references, and data atomically and is undoable.                                                                                                |
| 3. Composition and collections         | Example 2 passes with nested object, collection, variant, and fragment bindings. Reorder/insert/delete preserve surviving identities. Copy remaps internal references and preserves declared external ones. Validate incomplete results, invalid nesting, and missing dependencies explicitly.                                                                            |
| 4. Semantic planning and history       | Example 3 passes through built public APIs and the real authority/client path. Failure leaves no accepted partial state; protected consequences reject the whole action. Check concurrent edits, stale plans including structurally valid candidates with stale action scope, duplicate delivery, own undo/redo, bounded rule failure, and absence of postcommit repairs. |
| 5. Incremental integration             | Rebuild the derived model from persisted data, then verify targeted invalidation against that result. An unrelated edit does not reevaluate all bindings or clone the full document. Report representative fixtures, dependency fan-out, operation counts, timing, and remaining limits.                                                                                  |

Test required behavior, not a duplicated implementation algorithm. Include a
headless non-text fixture and a text-bearing fixture using the same shared module.
Keep the edit/test loop short with focused Bun tests and the existing development
gate; run the required full checks before implementation delivery. Introduce no
heavy dependency or universal framework merely to demonstrate these examples.

Publish the implemented contract, version/dependency policy, diagnostics, runnable
examples, and limits through the maintained guides. Lossy export, cross-document
updates, and unavailable component implementations must have honest contracts.
Do not substitute another research-only document for these implementation outcomes.
