# ml-collab-codec documentation

## Use the library

The API guides below describe the current contract. Their `ts` examples and the root
README examples are executed by `tests/acceptance/mr-delivery.test.ts` on `bun run check`.
Methodology and configuration recipes in subdirectories are guidance, not executable
API-example claims.

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

## Develop applications using the library

- [Application design](design/README.md): human/agent products, flexible
  experimentation and concrete codec integration. Retain it after initial adoption.
- [Development recommendations](development/README.md): optional quality
  baseline and configuration recipes for the consuming application.

## Contribute to the library

Repository `AGENTS.md`, `SPEC.md`, `ACCEPTANCE.md` and the verification guide govern
library maintenance. `REFERENCES.md` and root revision/acceptance handoffs preserve
implementation provenance and contract decisions; they are distinct from consumer
methodology. Do not delete or supersede specifications as part of handoff cleanup.
