# ml-collab-codec guides

These guides describe the current API. Every `ts` code block is a complete program that
`tests/acceptance/mr-delivery.test.ts` runs against the source on each `bun run check`.

| Guide                                           | Covers                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Installation](installation.md)                 | Pinned-Git consumption, build recipe, supported runtimes                                     |
| [Schemas](schemas.md)                           | JSON Schema authoring, supported keywords, annotations, defaults, diagnostics, legacy import |
| [Documents and source format](documents.md)     | Tagged source, JSON model, roots and fragments, effective values, save/reopen                |
| [Operations](operations.md)                     | The 13 primitives: fields, coordinates, inverses, conflict policy, builders                  |
| [Collaboration](collaboration.md)               | Authority and clients, receipts, undo/redo, join from a snapshot, sessions, restricted views |
| [Hosting and retention](hosting.md)             | Async durable store contract, checkpoints, pruning, history horizons                         |
| [Agents and providers](agents.md)               | Diff, proposals and rebasing, provider schema exports and decoding                           |
| [Ownership and runtime](runtime.md)             | Read-only snapshots, copies, publication, derived state, projections, scheduling             |
| [Verification and performance](verification.md) | Commands, test families, reports, budgets, known limits                                      |
