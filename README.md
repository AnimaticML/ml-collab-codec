# CollabDocCodec

A TypeScript library for schema-defined structured documents: readable tagged source
and equivalent JSON, validation and diff, agent editing, and structural/text
operational transformation with collaborative undo/redo. Bun is the development and
test runner; the core has no DOM, Node, or Bun runtime dependency.

Licensed under the Apache License 2.0 (`LICENSE`). The source is public at
<https://github.com/AnimaticML/CollabDocCodec>; the npm package stays
`"private": true` (not published) until a release is decided.

Documents: `SPEC.md` (behavioral contract; §18 records the OT revision v3 decisions),
`ACCEPTANCE.md` (60 baseline scenarios plus R01–R54), `AGENTS.md` (workflow rules),
`OT_REVISION_HANDOFF.md` / `OT_REVISION_ACCEPTANCE.md` (the v3 assignment),
`REFERENCES.md` (sources).

## Quick start

```sh
bun install --frozen-lockfile
bun run check          # format, types, lint, dead code, build, all tests, inventory, core types
bun run test:property  # larger reproducible property/simulation budget
```

Runnable headless examples (each ends with `EXAMPLE_OK`):

```sh
bun run examples/rich-text.ts    # wrap + replace, agent proposal rebase, collaborative undo, save/reopen
bun run examples/board.ts        # additive deltas, one-group drag undo, save/reopen
bun run examples/hidden-hand.ts  # restricted regions, trusted action, participant export
bun run examples/canvas.ts       # class projection, derived graph with a frame scheduler, selector
```

## Using the library

### Local files: parse, edit, save — no room or history

```ts
import {
  parseDocument,
  serializeDocument,
  toTable,
  fromTable,
  createAllocator,
  ChangeBuilder,
  applyChanges,
} from "collab-doc-codec";

const parsed = parseDocument(source, schema); // diagnostics on invalid input, never silent defaults
if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
const table = toTable(parsed.value, createAllocator());
const changes = new ChangeBuilder(table, { replica: "local", seq: 1 }).set(
  "p1",
  "title",
  "Draft",
).changes;
const saved = serializeDocument(
  fromTable(applyChanges(table, changes), schema.id, schema.version),
  schema,
);
```

Every change is a self-contained reversible record: `invertChanges(decodeChanges(json))`
needs no snapshot or history.

### Collaboration: one authority per document, optimistic clients

```ts
import { Authority, Client, SequenceAllocator, schemaInvariants } from "collab-doc-codec";

const authority = Authority.create("doc-1", "epoch-1", table, {
  validators: [schemaInvariants(schema)],
});
const client = new Client({
  documentId: "doc-1",
  historyEpoch: "epoch-1",
  allocator: SequenceAllocator.open(persistentStore, newIncarnationId), // write-ahead, never reuses ids
  actor: authenticatedUser,
  table,
  revision: 0,
});

client.transact((b) => b.textReplace(runId, 5, 7, "15")); // applied locally at once
const request = client.nextRequest(); // one in flight per replica; bytes are frozen
const decision = authority.submit(request, { actor: authenticatedUser }); // actor comes from your auth layer
// Broadcast decision.transition to every client and decision.receipt to the author:
client.receive([decision.transition, decision.receipt]);
```

Retries resend `client.resend()` unchanged and get the stored receipt. A `resync`
decision means the base is past the retained horizon: call `client.resync(table,
revision, reason)` to keep local work as retained intent. On reconnect, restore from
`client.exportSession()`, fetch transitions after the saved revision, and resend the
in-flight request.

### Undo, redo, grouping

```ts
client.beginGroup("drag");
/* many transactions, possibly already sent */ client.endGroup();
client.undo(); // latest own group, rebased over everyone's later work
client.undo(groupId); // an older own group
client.redo();
```

Results are explicit: `requested`, `deferred` (waits for an in-flight original),
`cancelledLocally`, `noRemainingEffect`, `conflict`, or `unavailable`. Grouping and
pre-send compression are application policies (`typingHistoryPolicy`,
`conservativeCoalescing`, `noCoalescing`, or your own).

### Publication and runtime state

`client.getSnapshot()` is immutable and stable until content changes;
`subscribeCommits` delivers one `ModelCommit` per coherent update with a verified
`ChangeSummary` and an address `mapping`; `subscribeStatus` carries acknowledgements
and receipts; `subscribeErrors` receives subscriber failures. `ClassProjection`,
`DerivedGraph` (with an injected scheduler), and `createSelector` are small headless
adapters for class instances, lazy derived state, and functional consumers.

### Anchors and proposals

`mapAnchor(anchor, commit.mapping)` follows node, caret, original-content range, and
array-occurrence anchors. `proposeEdit({ table: A, revision }, B, author)` +
`rebaseProposal(proposal, authority)` rebases an agent's edit of its read base over
accepted work without touching the current state.

### Hosting, checkpoints, restricted regions

`exportCheckpoint` / `restoreAuthority` move a history between hosts;
`AuthorityHost` enforces the durable-store contract (compare-and-commit plus owner
fencing; stage → publish → prune checkpoints). `RestrictedAuthority` adds homogeneous
visibility regions, trusted actions, per-participant projected events, and partial
exports.

## Commands

| Command                           | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `bun run test`                    | Full Bun suite (unit, acceptance C/S/I/O/P/V/Q + R01–R54, API, tooling). |
| `bun run test:property`           | Larger reproducible property/simulation budget.                          |
| `bun run typecheck` / `:core`     | Strict TypeScript; core + runtime without DOM/Node/Bun ambient types.    |
| `bun run lint`                    | ESLint incl. file/function size limits.                                  |
| `bun run deadcode`                | Knip: unused files, exports, dependencies.                               |
| `bun run format:check` / `format` | Prettier.                                                                |
| `bun run acceptance:check`        | Inventory guard: every baseline and revision ID has a real named test.   |
| `bun run build`                   | ESM bundle and declarations in `dist/`.                                  |
| `bun run check`                   | All of the above in order (build before tests; built-package tests too). |
| `bun run clean`                   | Remove generated `dist`, `coverage`, `.artifacts` only.                  |

## Layout

```text
src/core/        codec, schema, table, reversible changes, apply, transform, compose,
                 builders, identity, protocol, authority, client, history, anchors,
                 proposals, checkpoints, host contract, visibility
src/runtime/     headless projection, derived-state graph, selector
src/adapters/    file and browser-bootstrap adapters
examples/        runnable headless examples
tests/acceptance baseline and R01–R54 scenario tests
tests/unit       transform algebra properties
tests/api        public-surface tests through src/index.ts
tests/fixtures   schemas, built-package consumers, fresh-process helpers
tests/support    generators, simulated room, fake durable store, fixtures
```

## Verification status (2026-09-24)

Executed in this repository with Bun 1.2.5, Node 20.11.0, TypeScript 5.9.3, ESLint
9.39.5, Knip 5.88.1, Prettier 3.9.8:

| Command / check                            | Result                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `bun run check`                            | exit 0; 139 tests in 27 files; 114 baseline + revision IDs covered         |
| `bun run test:property`                    | pass: TP1 ×2000, 2000 simulated 3-client histories ×120 steps, diff law    |
| Built package in Node, Bun, worker thread  | automated (Q01)                                                            |
| Built package in a real browser (Chromium) | `tests/fixtures/browser-check.html` run manually once; not automated in CI |
| TypeScript consumer of `dist/types`        | automated (Q02)                                                            |
| Live provider probes                       | none exist; not run (see SPEC §17.2)                                       |

Finite seeded runs are evidence, not a proof of transform correctness. `package.json`
declares `node >=22`; the Node checks here ran on 20.11.0.
