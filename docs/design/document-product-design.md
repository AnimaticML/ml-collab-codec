# Design a document product around the existing codec

Begin with a real task: its actor, existing context, desired artifact or state, ordinary
allowed variations, permissions and observable completion. Identify how a person or
external agent invokes the capability, supplies references, observes progress, handles
failure and retrieves or continues the result. Distinguish client agents, optional
agents inside the product and development agents.

Use [codec integration](codec-integration.md) to choose schema/version, stable identity,
semantic operations, invariants and collaborative editing boundaries. Keep generated
media, service resources and derived layout distinct from authoritative document state.
Human and agent entry points share policy; a visual editor is one projection, not a
second source of truth. Use one small actual public-API scenario to test fit early.

Choose host responsibilities explicitly: identity, permissions, storage and fencing,
transport, retry identity, retention, recovery and restricted visibility. A local-file
workflow need not deploy a server; a collaborative workflow must supply its actual host
contract. Do not claim the library provides production authentication or deployment.
Use an existing representation where a structured document adds no value.

Design human review and direct manipulation for the task, not one button per operation.
A result may be a document, media, CLI response or another agent's input. Discuss access,
cost, ownership and adoption when they constrain the scenario. Experimental model output
must be validated and labelled separately from accepted product behavior.

Alternate research, a headless experiment, a UI sketch, a design description and real
implementation as useful. Ask focused questions for consequential human choices; do
not require an exhaustive questionnaire or mock before code. Stop dependent work at
an agreed review point or unresolved capability/security boundary; continue independent
authorized work. Preserve experiment inputs, configuration, outputs and limitations.

Keep concise current decisions, reuse/replacement choices, known gaps, expected/observed
results and the next bounded assignment. For an existing product inspect current code
and evidence before redesign; preserve unrelated work. Verify actual built consumers
and affected behavior during development, with full project gates at declared acceptance
milestones. Setup, implementation, product acceptance and release evidence are distinct.
Repository instructions govern permissions and checks; this guide grants no external
actions, provisioning, publication or paid-provider authority.
