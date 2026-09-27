# ml-collab-codec

A TypeScript library for schema-defined structured documents: readable tagged source
and equivalent JSON, validation, identity-aware diff and agent proposals, structured-output
provider schemas, and structural/text operational transformation with one authority per
document and collaborative undo/redo. The core has no DOM, Node, or Bun dependency; Bun is
the development and test runner.

Licensed under the Apache License 2.0 (`LICENSE`). Source:
<https://github.com/AnimaticML/ml-collab-codec>. The package is not published to a registry
(`"private": true`); consume a pinned commit (see [Installation](docs/installation.md)).

## Example

```ts
import assert from "node:assert/strict";
import {
  applyChanges,
  ChangeBuilder,
  createAllocator,
  defineDocumentSchema,
  fromTable,
  parseDocument,
  serializeDocument,
  toTable,
} from "ml-collab-codec";

const schema = defineDocumentSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "example.article",
  version: "1.0.0",
  rootTag: "article",
  components: {
    article: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["p"] },
      props: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
    p: {
      identity: "stable",
      content: { mode: "mixed" },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
  },
});

const parsed = parseDocument(
  `<article id="a1" title="Draft"><p id="p1">Payment in 10 days.</p></article>`,
  schema,
);
if (!parsed.ok)
  throw new Error(parsed.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
const table = toTable(parsed.value, createAllocator());
const run = table.get("p1")?.children[0] ?? "";
const edit = new ChangeBuilder(table, { replica: "local", seq: 1 })
  .set("$root", "title", "Final")
  .textReplace(run, 11, 13, "15").changes; // self-contained, reversible records
const saved = serializeDocument(
  fromTable(applyChanges(table, edit), schema.id, schema.version),
  schema,
);
assert.equal(saved, `<article id="a1" title="Final"><p id="p1">Payment in 15 days.</p></article>`);
```

## Guides

[Installation](docs/installation.md) · [Schemas](docs/schemas.md) ·
[Documents and source format](docs/documents.md) · [Operations](docs/operations.md) ·
[Collaboration](docs/collaboration.md) · [Hosting and retention](docs/hosting.md) ·
[Agents and providers](docs/agents.md) · [Ownership and runtime](docs/runtime.md) ·
[Verification and performance](docs/verification.md)

Runnable headless examples (each ends with `EXAMPLE_OK`): `examples/rich-text.ts` (wrap
and replace, agent proposal rebase, collaborative undo, save/reopen), `examples/board.ts`
(additive deltas, one-group drag undo), `examples/hidden-hand.ts` (restricted regions,
trusted action), `examples/canvas.ts` (class projection, derived graph, selector).

Specification and evidence: `SPEC.md` (behavioral contract; §18 records the implemented
decisions), `ACCEPTANCE.md` (scenario IDs → tests), `reports/` (pair coverage, mutation
kills, benchmarks), `AGENTS.md` (workflow rules), and the handoffs listed in
`REFERENCES.md`.

## Commands

```sh
bun install --frozen-lockfile
bun run check          # format, types, lint, dead code, build, all tests, ID inventory, core types
bun run test:property  # larger seeded budgets
bun run test:mutation  # fault-injection report
bun run ot:report      # operation-pair coverage report
bun run bench          # benchmark report
```

## Layout

```text
src/core/        schema, codec, validation, table, reversible changes, apply, transform,
                 diff, builders, identity, protocol, authority, client, history, join,
                 checkpoints, host contract, anchors, proposals, providers, visibility
src/runtime/     projection, derived-state graph, selector
src/adapters/    file and browser-bootstrap adapters
examples/        runnable headless examples
docs/            guides (every ts block is executed by the tests)
reports/         generated evidence (coverage, mutation, benchmarks)
scripts/         reports, benchmarks, live probes, inventory guard
tests/           acceptance (scenario IDs), api (public surface), unit, tooling, support
```
