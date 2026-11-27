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
| [Native templates](native-templates.md)         | Persistent interfaces and bindings, keyed repeats, semantic planning and validation          |
| [Composition and extension](composition.md)     | Built-package interview and tabletop examples, dependency admission and reopening            |
| [Verification and performance](verification.md) | Commands, test families, reports, budgets, known limits                                      |

## Develop applications using the library

- [Application design](design/README.md): human/agent products, flexible
  experimentation and concrete codec integration. Retain it after initial adoption.
- [Development recommendations](development/README.md): optional quality
  baseline and configuration recipes for the consuming application.

## Native template implementation handoff

The `template-proposal-` series records the owner-selected direction for persistent
compositions, inferred object data and shared semantic actions.

- [Composition, data and operations](proposals/template-proposal-composition-data-and-operations.md)
  specifies the common contract, self-contained examples and implementation acceptance.
  These are extension requirements, not claims that the current library already
  implements templates or a generic autofix planner.

Find local files with `rg --files | rg '(^|/)template-proposal-'`.

## World and runtime proposals

The `proposal-world-runtime-` series records owner-requested research and
integration handoffs across Canvas IR, Video, Codec and Shell.

- [Document composition and component evolution](proposals/proposal-world-runtime-composition-and-evolution.md)
  investigates reusable schema components, identity, static embedding and later
  live extension. Start with a public-API consumer example; proposed mechanisms
  are not implemented library contracts.

The handoff links all seven documents in the series. Find local files with
`rg --files | rg '(^|/)proposal-world-runtime-'`.

## Contribute to the library

Repository `AGENTS.md`, `SPEC.md`, `ACCEPTANCE.md` and the verification guide govern
library maintenance. `REFERENCES.md` and root revision/acceptance handoffs preserve
implementation provenance and contract decisions; they are distinct from consumer
methodology. Do not delete or supersede specifications as part of handoff cleanup.
