# Proposal: document composition and component evolution

Date: 2026-11-24

Status: research handoff. The owner requested this proposal; it does not declare new
public APIs, an implemented extension system, or a replacement for the accepted codec
contract. Stage A can proceed independently of the later live-extension investigation.

**Series:** `proposal-world-runtime-` · **Recorded:** 2026-11-24

This owner-requested research and integration handoff records an agreed product
direction. Proposed schemas, package names, interfaces and execution guarantees
still require the worked examples below. It does not claim that those capabilities
are implemented or replace the repository's current public contracts.

The [consumer decision record](../composition.md) reports the runnable Stage A and B examples.

## Related handoffs

Each repository owns its part of the proposal. The common filename prefix makes
the seven handoffs discoverable without a separate umbrella repository.

| Repository                   | Handoff                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AnimaticML/canvas-ir`       | [World document, time and shared execution](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-document-and-execution.md)                       |
| `AnimaticML/canvas-ir`       | [World and motion observation](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-observation.md)                                               |
| `AnimaticML/canvas-ir`       | [Editor Toolkit extraction](https://github.com/AnimaticML/canvas-ir/blob/main/docs/proposal-world-runtime-toolkit.md)                                                      |
| `alexandr-panchenko/video`   | [World representations in Animatic](https://github.com/alexandr-panchenko/video/blob/main/docs/architecture/proposal-world-runtime-integration.md)                         |
| `alexandr-panchenko/video`   | [Animatic observation](https://github.com/alexandr-panchenko/video/blob/main/ml-animatic/docs/proposal-world-runtime-observation.md)                                       |
| `AnimaticML/ml-collab-codec` | [Document composition and component evolution](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/proposals/proposal-world-runtime-composition-and-evolution.md) |
| `AnimaticML/ml-collab-shell` | [Format/runtime discovery and access](https://github.com/AnimaticML/ml-collab-shell/blob/main/docs/architecture/proposal-world-runtime-capabilities.md)                    |

Find the local documents with `rg --files | rg '(^|/)proposal-world-runtime-'`.

## Purpose and ownership

Applications will combine independently developed document components. An Animatic
document may contain a reference to a world document and editable parameters for a
particular camera view. A world may contain a screen playing an Animatic. Humans and
agents should edit these documents through the same application functions and ordinary
codec operations.

Canvas IR is the proposed home for the world format and execution foundation. Animatic
owns audiovisual composition and montage. Shell owns authorized hosting and access to
application capabilities. This handoff owns the codec questions: composing schemas,
preserving identity and edit semantics, and determining what live component evolution
would require. It does not introduce world time, physics, cameras, or a runtime registry
into codec.

## Inspected baseline

The baseline is commit
[`5ed1b8a0790782164f829dcebdcc64f43dec381f`](https://github.com/AnimaticML/ml-collab-codec/commit/5ed1b8a0790782164f829dcebdcc64f43dec381f).
Recheck relevant contracts before implementation.

- [`DocumentModel`](../../src/core/types.ts) has one `schemaId`, one
  `schemaVersion`, and one root. [Source and JSON forms](../documents.md) preserve
  component trees; an operational table also contains internal handles that need not
  appear in an exported document.
- [`defineDocumentSchema`](../schemas.md) compiles a profile once. Components declare
  properties, content rules and identity. Schema references are local; arbitrary
  remote schema loading is not a public capability.
- `identity: "stable"` provides persistent component IDs.
  `unknownComponents: "preserve"` preserves undeclared tags opaquely; it does not
  install their validators, implementations or actions.
- [Collaboration](../collaboration.md) already supplies transactions, authoritative
  admission, retry identity and collaborative own-group undo. Trusted actions for
  restricted visibility also exist through `RestrictedAuthority`; they are not a
  general application capability catalog.
- [Runtime facilities](../runtime.md) include derived values and class projections.
  Their scheduling concerns recomputation against document snapshots, not simulation
  clocks or physical stepping.

The existing [integration guidance](../design/codec-integration.md) remains the starting
point. A new abstraction requires a demonstrated consumer gap.

## Agreed direction

**Semantic ownership and storage placement are separate.** A camera-parameter component
may live in an Animatic tree and participate in its history while the world component
module defines its meaning and domain actions. The parent owns placement in montage;
the referenced world owns staging and shared objects; each use owns its view parameters.

**Static composition comes first.** Investigate a composite profile assembled from
reusable schema declarations before changing the document model. An independently
maintained component module does not automatically require independently nested schema
authorities. A reference to another document remains a different case from a subtree of
the current document.

**Semantic actions and direct editing coexist.** An application function may calculate
several ordinary changes. Submit required consequences atomically, and use history
grouping for the meaningful undo step. A group spanning several requests does not turn
them into one atomic admission. Valid direct edits and agent proposals remain available;
mandatory invariants are enforced at admission rather than only by a preferred UI.

## Stage A: prove static composition

Use one interview world with two people and two Animatic occurrences showing shot and
reverse shot. Keep geometry and animation assets outside the document where existing
formats suffice. The codec example needs only world identity, a reference, and a small
parameter component; it need not implement a renderer.

### Research questions

1. **Composite profile.** Can existing declarations be combined into one accepted
   schema? Specify component naming, collisions, compatible versions, allowed nesting
   and responsibility for validation. Do not assume foreign-schema dispatch exists.
2. **Reference versus subtree.** Which parameters belong to the host tree, and which
   edits target the separate world document? Identify the authority and history for
   each action. Do not promise a global transaction across independent documents.
3. **Identity.** Establish persistent identities for source entities and host
   occurrences. Runtime instances must retain their source relationship without
   confusing multiple instances of the same asset. Internal table handles alone are
   insufficient for references expected to survive export and reimport.
4. **Versioned opening.** Define the minimum interpretation/dependency information
   needed to reopen the example. What remains preserved and editable when a component
   implementation is unavailable? Distinguish successful round-trip from executable
   support.
5. **Actions and concurrency.** Demonstrate a domain action that changes one occurrence
   through existing builders and `Client.transact`. A concurrent change to the other
   occurrence must survive the first actor's undo. Required multi-field consequences
   must share the atomic request.

### Required outputs

- A small runnable consumer example using built public exports and the existing
  authority/client path. Record the selected schema composition and ownership.
- Focused evidence for source/JSON round-trip, independent occurrence parameters,
  collaborative undo, and unavailable-component behavior.
- A decision table: already supported, consumer responsibility, or demonstrated codec
  gap. For each gap, provide the failing scenario and smallest proposed change.
- Documentation changes appropriate to the result: `schemas.md`, `documents.md`,
  `collaboration.md`, `agents.md`, or `design/codec-integration.md`. Keep API examples
  executable under the repository's existing documentation checks.

If composition works with existing APIs, that is a successful outcome. It does not
require a new package, primitive operation, or universal action framework.

## Stage B: preserve state while adding live components

This investigation is a separate follow-on, not a prerequisite for embedding scenes.
Its concrete consumer is a running tabletop document: an agent adds a new card type
and its JavaScript behavior while people continue working with existing state.

Dynamic `import()` loads an implementation. It does not itself establish a new schema,
agreement between collaborators, authoritative validation, durable dependency identity,
or recovery after reopening. Conversely, this scenario does not require a new VM or
programming language.

Investigate the smallest lifecycle that distinguishes:

- The document change recording a component/dependency and any new instances.
- The exact version of its declaration and executable implementation.
- The authority/client transition required to interpret subsequent edits consistently.
- Preservation of accumulated document state while runtime instances are replaced or
  extended; nonpersistent caches and active simulation state need an explicit policy
  owned by the runtime, not an implicit whole-document reset.
- Reopening with available, missing, or incompatible dependencies.
- Undo/removal when instances or later edits depend on the new type. Document undo
  does not automatically reverse external effects or restore a past simulation run.

The world/application owner specifies component behavior and state migration. Shell
specifies admission and loading placement. Codec determines whether the existing schema,
history and identity contracts suffice. Do not let untrusted renderer code replace
trusted authority validators merely by declaring a component in a document.

**Bounded proof:** add one type, use it through an ordinary domain action, retain a
concurrent unrelated edit, save and reopen, then exercise the explicitly supported undo
case. Report unsupported replacement/migration cases rather than generalizing from a
successful import. Produce a lifecycle decision record and only the codec changes
needed by that evidence.

## Package and integration decision

No new codec package is assumed. A reusable composition helper can begin inside the
existing library if multiple consumers demonstrate its need; application-specific
schema modules remain with their formats. Any new public API must retain the clean
core's existing platform boundary.

The handoff is complete when Stage A has a concrete supported contract and Stage B has
either a bounded demonstrated path or explicit remaining questions. This document is
research scope, not a parallel implementation queue. Follow repository instructions for
subsequent code, verification and canonical contract updates.
