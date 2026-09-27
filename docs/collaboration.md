# Collaboration

One logical **authority** per document admits requests in order; **clients** apply their
own edits immediately and reconcile with accepted transitions. The selected control
profile is `sdl.scalar-prefix/1`: a scalar confirmed revision, paired inclusion
transformation, one request in flight per replica. There is no vector-clock or
multi-writer mode. Transport, authentication, and storage are the host's; the library is
transport-neutral.

## Protocol

- A client's `transact` publishes locally at once. `nextRequest()` returns the next
  request envelope (frozen bytes, id `{ replica, seq }`); retries use `resend()`, which
  returns the identical bytes.
- `authority.submit(envelope, { actor })` (the actor comes from your auth layer, never from
  the envelope) rebases the request from its base revision over accepted transitions,
  checks rights and every validator on the final candidate, and records one terminal
  receipt: `applied` (with a transition), `alreadySatisfied`, or `rejected` (with a reason).
  A duplicate request returns the stored receipt; a base past the retained horizon returns
  `resync`.
- Deliver every transition to every client and the receipt to its author, in any order,
  duplicated or delayed: clients buffer gaps and ignore duplicates. A rejected request's
  work (and work that depended on it) is kept as **retained intent** for review, never
  silently dropped.
- `Authority.create(documentId, historyEpoch, table, { schema })` is the recommended setup:
  the initial state must satisfy the schema and every final candidate is validated
  (incrementally, equivalent to full validation). `validators` and `authorize` add
  application invariants and rights.

## Undo and redo

Undo and redo apply to the caller's own **groups** (an explicit `beginGroup`/`endGroup`
gesture, a typing run chosen by the `historyPolicy`, or one transaction). An undo is a new
request built from the group's current-context handle, rebased over everyone's later
work, so other people's edits survive. Results are explicit: `requested`, `deferred` (an
original is still in flight), `cancelledLocally` (the work was never sent),
`noRemainingEffect`, `conflict` (a later incompatible change), or `unavailable`.

## Joining from a snapshot

A **bootstrap** is state at revision V: the operational rows (internal handles preserved),
document and history identity, schema and profile versions, and the scope it was projected
for. It carries no transitions, receipts, or other actors' history. To join:

1. Subscribe to accepted transitions, then capture the snapshot (`beginJoin` does both), or
   read a stored checkpoint (`bootstrapFromCheckpoint`) plus the retained tail after it.
2. `joinClient({ bootstrap, transitions, schema, allocator, actor })`. Transitions at or
   below V are ignored; later ones apply once each; a gap waits for catch-up
   (`authority.transitionsSince(client.state.revision)`).
3. Keep delivering live transitions.

A fresh participant starts with **empty history** (`getStatus().history.status === "empty"`).
Own undo across restarts or devices needs the actor's saved session: `client.exportSession()`
stores pending requests (with their original bytes), retained intent, and history handles,
tagged with the actor and schema. Pass it back as `restore` for the same authenticated
actor. A session saved at revision U is attached in its own context: `joinClient`
reconstructs state U from the snapshot and the supplied transitions between U and V (the
records are self-contained, so it can step backward), attaches the session there, and
integrates forward. If those transitions are no longer retained, history is reported
`unavailable` and pending work becomes retained intent — nothing is guessed. Where to store
sessions is the host's choice (`SessionStore` is the port).

```ts
import assert from "node:assert/strict";
import {
  Authority,
  beginJoin,
  bootstrapFromCheckpoint,
  captureBootstrap,
  createAllocator,
  defineDocumentSchema,
  exportCheckpoint,
  joinClient,
  parseDocument,
  SequenceAllocator,
  textOf,
  toTable,
  type Client,
  type ServerEvent,
  type TransitionEvent,
} from "ml-collab-codec";

const closed = { type: "object", properties: {}, additionalProperties: false } as const;
const schema = defineDocumentSchema({
  id: "example.collab",
  version: "1",
  rootTag: "doc",
  components: {
    doc: { identity: "none", content: { mode: "element", allowedTags: ["p"] }, props: closed },
    p: { identity: "stable", content: { mode: "mixed" }, props: closed },
  },
});
const parsed = parseDocument(`<doc><p id="p1">Hello world</p></doc>`, schema);
assert.ok(parsed.ok);
const authority = Authority.create("doc-1", "epoch-1", toTable(parsed.value, createAllocator()), {
  schema,
});
const run = authority.getTable().get("p1")?.children[0] ?? "";

// A tiny in-process transport: every transition to everyone, the receipt to its author.
const clients = new Map<string, Client>();
const send = (actor: string): void => {
  const client = clients.get(actor);
  const request = client?.nextRequest();
  if (client === undefined || request === undefined) return;
  const decision = authority.submit(request, { actor });
  if (decision.kind !== "decided") throw new Error(decision.reason);
  for (const [name, member] of clients)
    member.receive([
      ...(decision.transition === undefined ? [] : [decision.transition]),
      ...(name === actor ? [decision.receipt] : []),
    ] as ServerEvent[]);
};
const join = (actor: string, replica: string): Client => {
  const live: TransitionEvent[] = [];
  const { bootstrap, stop } = beginJoin(authority, schema, (t) => live.push(t));
  const client = joinClient({
    bootstrap,
    schema,
    allocator: SequenceAllocator.ephemeral(replica),
    actor,
  });
  stop(); // this in-process transport delivers directly from now on
  client.receive(live);
  clients.set(actor, client);
  return client;
};

const alice = join("alice", "replica-a");
const bob = join("bob", "replica-b");
alice.transact((b) => b.textInsert(run, 5, ","));
bob.transact((b) => b.textInsert(run, 11, "!"));
send("alice");
send("bob");
assert.equal(textOf(authority.getTable().get(run)), "Hello, world!");

// Alice's undo removes only her comma; Bob's exclamation mark survives.
assert.equal(alice.undo().status, "requested");
send("alice");
assert.equal(textOf(authority.getTable().get(run)), "Hello world!");
assert.equal(textOf(bob.getSnapshot().table.get(run)), "Hello world!");

// Alice continues on a new device: stored snapshot + retained tail + her own saved session.
alice.transact((b) => b.textInsert(run, 0, "> "));
send("alice");
const session = alice.exportSession();
const stored = exportCheckpoint(authority, schema);
bob.transact((b) => b.textInsert(run, 0, "[bob] "));
send("bob");
const phone = joinClient({
  bootstrap: bootstrapFromCheckpoint(stored),
  transitions: authority.transitionsSince(stored.revision) ?? [],
  restore: session,
  schema,
  allocator: SequenceAllocator.ephemeral("replica-a-phone"),
  actor: "alice",
});
clients.set("alice", phone);
assert.equal(phone.getStatus().history.status, "restored");
assert.equal(phone.undo().status, "requested"); // her "> " prefix, rebased over Bob's edit
send("alice");
assert.equal(textOf(authority.getTable().get(run)), "[bob] Hello world!");

// Someone else holding Alice's session cannot adopt her history.
assert.throws(() =>
  joinClient({
    bootstrap: captureBootstrap(authority, schema),
    restore: session,
    schema,
    allocator: SequenceAllocator.ephemeral("replica-m"),
    actor: "mallory",
  }),
);
```

## Restricted regions

A component with `regionOwner` in the schema owns its subtree for that string property's
value; unmarked content is public. `RestrictedAuthority` checks that a participant's
request touches only content visible to them (atomically with admission), runs trusted
application actions (`registerAction` / `submitAction`) for operations that need hidden
state, and produces per-participant events with `eventsFor(principal)`. A change that stays
within regions the participant sees is delivered as the original records (same handles);
a reveal or hide is delivered as a projected diff. Participants bootstrap from their
projection: `captureBootstrap(restricted.authority, schema, { principal, table:
restricted.view(principal) })`. Never send a full checkpoint to a participant.
