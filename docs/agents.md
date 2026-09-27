# Agents and providers

## Proposals from free edits

An agent (or any offline editor) reads document state **A** at revision r, produces a new
document **B** however it likes (for example on an `editableCopy`, or from a model's
structured output), and proposes the difference. `proposeEdit({ table: A, revision: r }, B, author)`
computes `diff(A, B)` as ordinary reversible primitives; `rebaseProposal(proposal, authority)`
moves them over everything accepted since r without touching the current state. The result
is submitted like any request (with current rights and validation). A conflict keeps the
original proposal for review; a base that is no longer retained reports
`contextUnavailable`. Never diff the current state C against B: that would attribute other
people's later work to the agent.

`diffToChanges` is identity-aware:

- nodes are matched by persisted id (a same-id tag change is one `setTag`); anonymous nodes
  and text are aligned by a longest-common-subsequence over identity keys, so kept siblings
  are not deleted and recreated; a removed wrapper's persisted descendants are moved out,
  not recreated;
- properties are compared per nested field; arrays by a positional prefix/suffix splice with
  same-position objects edited in place (equal values are occurrences, not identities);
- text is diffed into separate hunks (`textHunks`), so distant edits stay separate and
  concurrent work between them survives.

Coarse boundaries (documented, tested): anonymous siblings have only positional identity;
child lists longer than the LCS budget (4 million comparison cells) fall back to replacing
the unmatched middle (persisted nodes are still moved); a document root's id cannot change.

```ts
import assert from "node:assert/strict";
import {
  Authority,
  ChangeBuilder,
  createAllocator,
  editableCopy,
  fromTable,
  proposeEdit,
  rebaseProposal,
  textOf,
  toTable,
} from "ml-collab-codec";

const authority = Authority.create(
  "doc",
  "epoch",
  toTable(
    {
      schemaId: "x",
      schemaVersion: "1",
      root: {
        tag: "doc",
        props: { status: "draft" },
        content: [{ id: "p1", tag: "p", props: {}, content: ["alpha beta gamma delta"] }],
      },
    },
    createAllocator(),
  ),
);
const read = { table: authority.getTable(), revision: authority.getRevision() };
const run = read.table.get("p1")?.children[0] ?? "";

// The agent edits a private copy of A: capitalizes both ends and marks the status.
const b = editableCopy(fromTable(read.table, "x", "1"));
b.root.props["status"] = "reviewed";
const paragraph = b.root.content[0];
if (typeof paragraph !== "string") paragraph.content = ["ALPHA beta gamma DELTA"];
const proposal = proposeEdit(read, b.root, { replica: "agent", seq: 1 });

// Meanwhile a person types in the middle.
const typed = new ChangeBuilder(read.table, { replica: "person", seq: 1 }).textInsert(
  run,
  11,
  "(!)",
).changes;
authority.submit(
  {
    profile: "sdl.scalar-prefix/1",
    opFormat: "sdl.ops/2",
    documentId: "doc",
    historyEpoch: "epoch",
    replica: "person",
    seq: 1,
    baseRevision: 0,
    changes: typed,
    meta: {},
  },
  { actor: "person" },
);

// The proposal rebases over the person's work; both survive.
const rebased = rebaseProposal(proposal, authority);
assert.equal(rebased.status, "rebased");
if (rebased.status === "rebased")
  authority.submit(
    {
      profile: "sdl.scalar-prefix/1",
      opFormat: "sdl.ops/2",
      documentId: "doc",
      historyEpoch: "epoch",
      replica: "agent",
      seq: 1,
      baseRevision: rebased.revision,
      changes: rebased.changes,
      meta: {},
    },
    { actor: "agent" },
  );
assert.equal(textOf(authority.getTable().get(run)), "ALPHA beta (!)gamma DELTA");
assert.equal(authority.getTable().get("$root")?.props["status"], "reviewed");
```

## Structured-output provider exports

A model can produce data directly against the schema:

- `exportComponentProperties(schema, tag, provider)` — one component's properties.
- `exportDocument(schema, provider, route?)` — a whole document, either as a native
  recursive tree (`nativeTree`, where the provider supports recursion and the measured
  depth fits) or as a typed row projection (`rowProjection`: one row per node or text run,
  props typed per component, parents by temporary wire reference). The default route is the
  native tree only when it fits the provider's budgets.

Each export reports `generationEnforced` (constraints present in the emitted schema that
the provider enforces while generating), `localOnly` (constraints weakened or dropped for
the provider and checked after decoding), `incompatibilities`, the `measured` depth,
property count, and union variants, and the `budgets` it was measured against with their
basis (`documented` by the provider, or a conservative `internal` choice). Profiles are
dated evidence (`PROVIDER_PROFILES[provider].retrieved`, `sources`), not live guarantees.

`decodeProviderResponse` / `decodeProviderOutput` accept only an `ok` response with JSON
that satisfies the emitted schema, then apply the complete local contract (the same
effective-value normalization, structure, identity, reference, and nesting checks as
every other entry point). Refusals, incomplete output, malformed rows, cycles, duplicate
or dangling wire references, and locally invalid values never become applicable data.
Wire references are not persistent ids. `encodeProviderOutput` is the paired encoder
(useful for fixtures and tests).

```ts
import assert from "node:assert/strict";
import {
  decodeProviderResponse,
  defineDocumentSchema,
  exportComponentProperties,
} from "ml-collab-codec";

const schema = defineDocumentSchema({
  id: "example.task",
  version: "1",
  rootTag: "task",
  components: {
    task: {
      identity: "none",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          priority: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
});
const exported = exportComponentProperties(schema, "task", "anthropic");
assert.ok(exported.localOnly.includes("task.priority:minimum")); // not enforced by that provider
const ok = decodeProviderResponse({ status: "ok", json: '{"title":"Ship it"}' }, exported, schema);
assert.deepEqual(ok.ok && ok.value, { title: "Ship it", priority: 3 });
const invalid = decodeProviderResponse(
  { status: "ok", json: '{"title":"x","priority":9}' },
  exported,
  schema,
);
assert.equal(invalid.ok, false); // checked locally even though generation did not enforce it
assert.equal(
  decodeProviderResponse({ status: "refusal", reason: "policy" }, exported, schema).ok,
  false,
);
```

Live checks against real provider APIs are opt-in: `PROBE_LIVE=1 bun run probe:live`
with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` set sends only a synthetic
fixture schema and prompt and prints one status line per provider (`passed`, `failed`,
`skipped`, or `error`). Credentials are never printed. Without the opt-in, every provider
reports `skipped`; default tests behave the same with or without credentials.
