# Ownership and runtime

## Ownership contract

- **Acquisition copies.** `toTable`, `ChangeBuilder.set` / `arrayInsert`, inserted node
  specs, and parsed or decoded models copy their inputs; later edits to the caller's
  objects do not reach the library.
- **Borrowed views are read-only.** Snapshots, tables, rows, props, child lists, records, and
  models are deeply `readonly` in the types. Rows are frozen objects; nested props and child
  arrays are not frozen at runtime (freezing large arrays is costly), so writing through a
  cast is outside the supported contract and may corrupt shared state. Narrow JSON arrays
  with `isJsonArray` — TypeScript's `Array.isArray` widens a readonly array to `any[]`.
- **Free edits use copies.** `editableCopy(model)` returns an independent, deeply mutable
  document; edit it freely and propose the result (see [Agents](agents.md)).
- **Wire bytes are frozen.** A sent request envelope is deeply frozen and never rebased in
  place; accepted records, receipts, and old snapshots never change afterwards.
- **Failed work leaves no trace.** A transaction that throws midway publishes nothing and
  leaves the client state unchanged.

Untouched rows are shared by identity between versions, so consumers can compare rows by
reference.

## Publication

`client.getSnapshot()` returns an immutable snapshot that stays the same object until
visible content changes. `subscribeCommits` delivers one `ModelCommit` per public call —
`{ previous, next, changes, mapping, cause }` with a verified `ChangeSummary` (created,
deleted, props, text, children, moved, retagged) and the address `mapping` from previous to
next (for anchors: `mapAnchor`). Acknowledgements and receipts that do not change content
go to `subscribeStatus`. Subscriber exceptions go to `subscribeErrors`; they never undo a
publication. Edits made from inside a subscriber run after delivery as their own commit.

## Derived state and scheduling

`DerivedGraph` computes derived values lazily against published snapshots, tracks exactly
which inputs each derivation read (props by top-level field, text, children, existence,
other derivations, and external inputs such as font metrics), and recomputes only what a
commit or external change invalidated — through reverse indexes, never a scan of every
derivation. Pass a `Scheduler` to batch recomputation into frames; `read` computes the
needed closure on demand. `defineAsync` runs work outside the frame (a worker layout, for
example): until its job completes the value is `notReady`; a late result invalidates its
dependents, schedules a flush, and notifies `subscribe` listeners; `fail` records
`failed` and `retry` starts a new job; results for changed inputs, removed or redefined
keys, or superseded jobs are discarded.

```ts
import assert from "node:assert/strict";
import {
  Client,
  createAllocator,
  DerivedGraph,
  SequenceAllocator,
  toTable,
  type AsyncState,
} from "ml-collab-codec";

const table = toTable(
  {
    schemaId: "x",
    schemaVersion: "1",
    root: {
      tag: "canvas",
      props: {},
      content: [{ id: "box", tag: "box", props: { x: 10 }, content: ["label"] }],
    },
  },
  createAllocator(),
);
const client = new Client({
  documentId: "d",
  historyEpoch: "e",
  allocator: SequenceAllocator.ephemeral("r"),
  actor: "u",
  table,
  revision: 0,
});

const frames: (() => void)[] = [];
const graph = new DerivedGraph(client.getSnapshot().table, {
  schedule: (task) => (frames.push(task), () => undefined),
});
client.subscribeCommits((commit) => graph.update(commit.next.table, commit.changes));

const jobs: ((width: number) => void)[] = [];
graph.defineAsync<number>("width:box", (ctx, done) => {
  const text = ctx
    .children("box")
    .map((run) => ctx.text(run))
    .join("");
  jobs.push(() => done(text.length * 7)); // pretend a worker measures the text later
});
graph.define("right:box", (ctx) => {
  const width = ctx.derived<AsyncState<number>>("width:box");
  return width.status === "ready" ? Number(ctx.prop("box", ["x"])) + width.value : undefined;
});

assert.equal(graph.read("right:box"), undefined); // layout not ready yet
jobs.shift()?.(0);
frames.splice(0).forEach((frame) => frame()); // the completed job invalidated its dependent
assert.equal(graph.read("right:box"), 10 + 5 * 7);

client.transact((b) => b.set("box", "x", 20)); // position only: no new layout job
frames.splice(0).forEach((frame) => frame());
assert.equal(jobs.length, 0);
assert.equal(graph.read("right:box"), 20 + 5 * 7);
```

`ClassProjection` keeps application class instances in step with commits (install phase
with reactions suspended, then reference resolution for changed instances and the
instances that referenced them, then one graph update). `createSelector` memoizes a pure
function of explicitly selected inputs for functional consumers.
