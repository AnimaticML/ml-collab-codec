# Hosting and retention

The pure `Authority` decides requests in memory. `AuthorityHost` connects it to durable
storage through the asynchronous `DurableStore` port, with a single effective writer per
document history. No particular database is required; implement the port on anything with
a compare-and-set.

## The store contract

| Method                                | Must guarantee                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `acquire()`                           | returns a new owner generation that fences all earlier ones                                         |
| `append(position, owner, record)`     | compare-and-commit on the log position; `committed` only after the decision and receipt are durable |
| `read()`                              | the published checkpoint, the records after its cut, and the log position                           |
| `stageCheckpoint(bundle, cut, owner)` | stores a candidate checkpoint (owner-fenced)                                                        |
| `publishCheckpoint(id, owner)`        | makes it current; never replaces a checkpoint with an older cut (`superseded`); owner-fenced        |
| `pruneThrough(cut, owner)`            | removes records up to the published cut only (`refused` beyond it); owner-fenced                    |

A rejected promise means the outcome is unknown. The host serializes submissions and
checkpoints, installs a decision only after `committed`, and after `stale` or an unknown
outcome reloads checkpoint + tail and re-evaluates (a retry then finds its stored
decision). A `fenced` result throws `StaleOwnerError`: another host owns the history.
`host.subscribe` reports transitions in revision order across reloads.

```ts
import assert from "node:assert/strict";
import {
  Authority,
  AuthorityHost,
  ChangeBuilder,
  CONTROL_PROFILE,
  createAllocator,
  OPERATION_FORMAT,
  toTable,
  type CheckpointBundle,
  type DecisionRecord,
  type DurableStore,
  type StoredHistory,
} from "ml-collab-codec";

/** An in-memory store honouring the contract (a real one would use a transactional database). */
class MemoryStore implements DurableStore {
  private log: { position: number; record: DecisionRecord }[] = [];
  private staged = new Map<string, { bundle: CheckpointBundle; cut: number }>();
  private published: { bundle: CheckpointBundle; cut: number } | undefined;
  private owner = 0;
  private end = 0;
  read(): Promise<StoredHistory> {
    const cut = this.published?.cut ?? 0;
    return Promise.resolve({
      checkpoint: this.published?.bundle,
      records: this.log.filter((e) => e.position > cut).map((e) => e.record),
      position: this.end,
    });
  }
  append(expected: number, owner: number, record: DecisionRecord) {
    if (owner !== this.owner) return Promise.resolve("fenced" as const);
    if (expected !== this.end) return Promise.resolve("stale" as const);
    this.log.push({ position: (this.end += 1), record: structuredClone(record) });
    return Promise.resolve("committed" as const);
  }
  acquire(): Promise<number> {
    return Promise.resolve((this.owner += 1));
  }
  stageCheckpoint(bundle: CheckpointBundle, cut: number, owner: number) {
    if (owner !== this.owner) return Promise.resolve("fenced" as const);
    const id = `cp${this.staged.size}`;
    this.staged.set(id, { bundle: structuredClone(bundle), cut });
    return Promise.resolve({ staged: id });
  }
  publishCheckpoint(id: string, owner: number) {
    const staged = this.staged.get(id);
    if (owner !== this.owner || staged === undefined) return Promise.resolve("fenced" as const);
    if (this.published !== undefined && staged.cut < this.published.cut)
      return Promise.resolve("superseded" as const);
    this.published = staged;
    return Promise.resolve("published" as const);
  }
  pruneThrough(cut: number, owner: number) {
    if (owner !== this.owner) return Promise.resolve("fenced" as const);
    if ((this.published?.cut ?? -1) < cut) return Promise.resolve("refused" as const);
    this.log = this.log.filter((e) => e.position > cut);
    return Promise.resolve("pruned" as const);
  }
}

const schema = { id: "example.hosted", version: "1" };
const genesis = () =>
  Authority.create(
    "doc",
    "epoch",
    toTable(
      {
        schemaId: schema.id,
        schemaVersion: schema.version,
        root: { tag: "board", props: { total: 0 } },
      },
      createAllocator(),
    ),
  );
const request = (replica: string, seq: number, base: number, by: number): unknown => ({
  profile: CONTROL_PROFILE,
  opFormat: OPERATION_FORMAT,
  documentId: "doc",
  historyEpoch: "epoch",
  replica,
  seq,
  baseRevision: base,
  changes: new ChangeBuilder(genesis().getTable(), { replica, seq }).delta("$root", "total", by)
    .changes,
  meta: {},
});

const store = new MemoryStore();
const host = await AuthorityHost.open(store, schema, genesis);
await host.submit(request("replica-a", 1, 0, 5), { actor: "a" });
await host.submit(request("replica-b", 1, 0, 7), { actor: "b" }); // concurrent: rebased and added
await host.checkpoint(1); // stage, publish, then prune — keeping one transition for late rebases
const again = await host.submit(request("replica-a", 1, 0, 5), { actor: "a" }); // a network retry
assert.equal(again.kind === "decided" && again.duplicate, true);

// A new process (or another host) takes over from checkpoint + tail; the old owner is fenced.
const successor = await AuthorityHost.open(store, schema, () => {
  throw new Error("genesis is not needed once a checkpoint exists");
});
assert.equal(successor.authority.getTable().get("$root")?.props["total"], 12);
await assert.rejects(host.submit(request("replica-c", 1, 2, 1), { actor: "c" }));
```

## Checkpoints and horizons

`exportCheckpoint(authority, schema, retain)` captures trusted state at revision V: the
rows, `retain` transitions ending at V (by default none), and the receipt ledger. The
retained transitions are already part of the state — they are context for late rebases and
exact backward steps, never a tail to replay. `importCheckpoint` / `restoreAuthority` read
checkpoints strictly (formats, profiles, schema interpretation, unique rows, one root,
consistent parents and children, no cycles, bounded depth and size, schema validity when
a profile is given, contiguous and invertible retained transitions, a well-formed ledger,
a contiguous decision tail) and construct nothing on failure (`SnapshotError`).

Three horizons are independent:

- **Late rebase**: requests based before `authority.retainedFrom()` get `resync`
  (`pruneTransitionsThrough` moves it). The client keeps its work as retained intent.
- **Deduplication**: receipts answer retries until `expireReceiptsThrough`; after that a
  retry answers `resync`, never a fresh decision.
- **Own undo**: a client's handles live in its session (current-context, self-contained)
  and survive pruning; a session older than the retained transitions reports its history
  unavailable when joining.
