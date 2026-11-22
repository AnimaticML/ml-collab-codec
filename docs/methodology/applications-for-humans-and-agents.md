# Applications for Humans and Agents

For schema-defined shared documents, make this concrete with [codec integration](codec-integration.md): reuse document identity, validated edits, collaboration and proposals rather than rebuilding them. Other artifacts retain their suitable formats.

This is the product-design frame for the methodology, not a claim that every application or integration platform already behaves this way. Use it when forming or reconsidering a product; a coding agent does not need to reread it for every task.

## Design for the workflow around the application

A person need not begin by opening a homepage. The task may already exist in a conversation, document, calendar, repository, or external event. Another agent may already hold the relevant context and need one specialized capability to continue the work.

Design the application so that a human or authorized agent can obtain the intended outcome without unnecessarily reconstructing context through screens. A website, embedded chat, skill, local utility, API, or agent-callable service is an access surface, not the product's complete definition.

Distinguish three roles: an external agent using the product, an optional specialized agent inside the product, and the development agent building it. An application can serve external agents without containing another LLM. Conversely, adding an embedded chatbot does not automatically make the application usable by external agents.

## One semantic domain, several ways to use it

Build the meaning of the system once. Its human workspace, agent operations, and artifacts should operate on the same relevant domain state and rules.

```text
                   Semantic domain system
                     /       |       \
              Artifacts   Agent use   Human use
              and state   and tools   and review
```

This is a semantic principle, not a requirement for one process, database, binary, or universal intermediate format. Introduce representations and services when their consumers and responsibilities justify them.

A useful operation expresses intent: append lyrics, validate a contract, choose a revision, schedule an occurrence, or assemble a video. The domain enforces permissions, invariants, and effects. Agents should not have to reconstruct these meanings from database primitives or coordinates on a screen.

Where interpretation is needed, the LLM chooses meaningful operations. Deterministic code performs the defined transitions. For example, committing a lyrics revision can trigger audio rendering as a defined effect; the conversational agent need not separately remember every downstream action.

## Agents as clients, not just assistants in a panel

An agent-facing contract needs enough information to complete real work: how to discover an appropriate capability, obtain permitted access, provide or reference context, invoke the operation, inspect progress, handle a failure, and retrieve or continue from the result.

Use an ordinary deterministic capability when the requested semantics are already clear. Place a specialized agent behind the boundary when substantial domain interpretation is part of the service. Do not add an extra agent merely to forward an already well-defined call.

Choose the interface for its actual caller. MCP may suit agent discovery and invocation; local commands, files, HTTP, queues, or internal functions may suit other boundaries. Do not turn every internal operation into a public tool. Discoverability does not confer authorization, and another agent's request does not create new permissions or spending authority.

## State survives the conversation

Conversation communicates intent, questions, and explanations. Persistent workspace state and explicit artifacts preserve the work. Keep source references, revisions, results, and essential decisions where the next participant can inspect and resume them.

An artifact can be an existing file format, a document, media, a render specification, or structured workspace state. A new intermediate representation is justified by an actual need for validation, handoff, editing, reproducibility, or rendering—not by a desire to fill an architectural diagram.

Preserve immutable history where its meaning matters: approved documents, media revisions, past planner entries, or audit-sensitive actions. Use explicit triggers and effects rather than vague instructions for an agent to run continuously. Treat time as an explicit dependency when reproducibility matters to the domain.

## The human projection has a purpose of its own

The human may create, inspect, listen, compare, approve, explore, or intervene. These responsibilities do not imply a button or editor for every operation available to an agent.

A notebook may be read-only to the person while the agent updates it through domain operations. A different product may require precise direct manipulation. Choose these responsibilities together with the domain and capabilities; do not derive the UI mechanically from a feature catalog.

The main workspace might be a document, world, canvas, timeline, search result, conversation, or genuine monitoring dashboard. The metaphor is not a visual skin. It determines attention, actions, navigation, feedback, and the role of secondary tools. An embedded chat can support the workspace without displacing it.

Where appropriate, one conversational input can serve several intents. Proactivity should help without turning the experience into an interrogation or blocking ordinary work.

## Agent use changes distribution and payment design

A product may be adopted through a person's recommendation, a company integration, a skill used by a coding agent, or a discoverable specialized capability. Determine the intended route early. A public landing page and a self-service subscription are possibilities, not universal requirements.

An agent-mediated route may need usable capability descriptions, identity and access setup, machine-readable limits, and a way to request human approval. Payment cannot rely solely on an unexpected screen that the calling agent cannot operate. Keep payer, user, caller, owner of data, and approving authority distinct where they differ.

A hackathon may prioritize a working judging route and repository access. A company project may prioritize a pilot and integration into an existing process. These constraints shape the product from the design conversation, even when their final execution comes later.

## Personal defaults remain conditional

The methodology contains preferred technologies and working practices because they reduce friction for its owner. They are not universal architectural laws. An on-premise requirement, customer infrastructure, or different workload can justify another route.

A good project decision may later become a reusable methodological branch, with its applicability stated. Research establishes what is documented; experiments establish what worked under tested conditions. Keep those kinds of evidence distinct from preferences and selected-but-unverified decisions.
