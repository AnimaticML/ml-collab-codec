# Design with ml-collab-codec

Use [ml-collab-codec](https://github.com/AnimaticML/ml-collab-codec) for schema-defined
structured documents shared by humans and agents. Its public ESM API owns parsing,
serialization, validation, stable identity, reversible edits, diff/proposals,
collaborative clients/authority, own-group undo and derived projections. Keep domain
meaning in the consuming product; do not replace these mechanisms with snapshot
writes or a parallel collaboration engine.

## Prove one document scenario

Define the document's schema/version, stable entities, references, invariants and
ordinary allowed edits. Distinguish document state from external resources, generated
media and derived presentation. Use an existing suitable format rather than inventing
an intermediate representation for every artifact.

Read or project the same authoritative state for human presentation and agent use.
Use transactions/builders for defined edits and editable copies plus proposals for
agent-authored changes. Compute a proposal from the agent's original read state and revision to its proposed
result, then rebase over intervening work. Never diff the latest shared state against
the proposed result: that can attribute collaborators' edits to the agent. Preserve
rejected or unresolvable intent for review. A model response must pass full local validation,
including constraints not enforced by a provider's structured-output schema.

Keep one logical authority per document. Supply authenticated identity from the host,
not request claims; configure schema validation, authorization and domain invariants
at admission. Undo/redo belongs to the caller's groups and preserves others' work;
it is not restoration of an earlier whole-document snapshot.

Reuse codec's `AuthorityHost`, joining, retry and session mechanisms. The consuming
host implements transport and the durable-store port, including atomic commit and
single-writer fencing; it supplies authenticated identity and configures allocator
persistence, retention and recovery. Do not rebuild
codec's coordination algorithms. A durable acknowledgement follows committed storage,
not merely optimistic local publication. Use coherent
snapshot/tail joining. Session restore needs the same actor and retained context;
unavailable history or retained pending intent must be visible, not silently replayed
or discarded. Restricted content requires participant-specific projections before
delivery, including bootstrap; UI hiding is not access control.

Borrowed snapshots are read-only, not mutable application models or security sandboxes.
Use copied edits, commit/status subscriptions and derived-state APIs according to their
ownership contracts. Distinguish local publication, authoritative acceptance and durable
persistence. Dispose subscriptions and reject stale asynchronous results as documented.

## Integrate and verify

Pin a compatible commit and follow the repository's [installation guide](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/installation.md).
The inspected checkout is private-to-registry (`private: true`), consumed by pinned Git
checkout/path and built exports; do not assume an npm release. Use public exports,
not source deep imports. Verify the built consumer in its actual runtime.

Use the maintained guides for [schemas](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/schemas.md),
[agent proposals/providers](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/agents.md),
[collaboration](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/collaboration.md),
[hosting](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/hosting.md) and
[runtime ownership](https://github.com/AnimaticML/ml-collab-codec/blob/main/docs/runtime.md).
Read the equivalents at the selected commit; these links locate the current guides.

Exercise actual public APIs and the relevant host/presentation integration. A
headless scenario is a cheap proof of fit, not a mandatory stage before an application
prototype; start at whichever boundary resolves the current question. Cover concurrent human/agent edits, rejection, retries, reconnect and own
undo when applicable. Keep provider probes opt-in and within authorized cost limits.
Record versions, expected/observed results and unsupported cases; library guarantees
do not prove the consuming product's permissions, effects or usability.
