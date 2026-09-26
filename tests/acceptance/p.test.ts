import { expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import { invertChanges } from "../../src/core/change.ts";
import type { Change } from "../../src/core/change.ts";
import { compose } from "../../src/core/compose.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import { isConflict, rebase } from "../../src/core/transform.ts";
import { listDoc, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

test("P01 Three-client convergence", () => {
  const room = new Room(textDoc("abc"));
  const names = ["c1", "c2", "c3"];
  names.forEach((name) => room.join(name, `replica-${name}`));
  room.client("c1").transact((b) => b.textInsert("t", 0, "1"));
  room.client("c2").transact((b) => b.textDelete("t", 1, 1));
  room.client("c3").transact((b) => b.textInsert("t", 3, "3"));
  // Reordered processing: c3, then c1, then c2; acknowledgements delayed and delivered out of order.
  room.send("c3");
  room.send("c1");
  room.send("c2");
  room.client("c2").transact((b) => b.textInsert("t", 0, "2")); // more pending work while waiting
  for (const name of ["c2", "c1"]) {
    const inbox = room.member(name).inbox;
    room.member(name).inbox = [...inbox].reverse();
  }
  room.settle();
  const truth = textOf(room.authority.getTable().get("t"));
  // "1" (replica-c1) and "2" (replica-c2) were both authored at gap 0 without seeing each other: origin order.
  expect(truth).toBe("12ac3");
  for (const name of names)
    expect(textOf(room.client(name).getSnapshot().table.get("t"))).toBe(truth);
  expect(
    room.decisions.filter((d) => d.kind === "decided" && d.receipt.outcome === "applied"),
  ).toHaveLength(4);
});

test("P02 Rejection with dependent pending edits", () => {
  const room = new Room(listDoc({ x: 0, title: "t" }));
  const client = room.join("c1", "replica-c1");
  const rival = room.join("c2", "replica-c2");
  client.transact(
    (b) => void b.insertNode(ROOT_ID, 0, { tag: "item", id: "N", props: { label: "mine" } }),
  );
  client.closeGroup();
  client.transact((b) => b.set("N", "label", "depends on N"));
  client.closeGroup();
  client.transact((b) => b.set(ROOT_ID, "title", "independent"));
  rival.transact(
    (b) => void b.insertNode(ROOT_ID, 0, { tag: "item", id: "N", props: { label: "rival" } }),
  );
  room.send("c2");
  room.send("c1");
  room.settle();
  const retained = client.getStatus().retained.map((r) => [r.status, r.id.seq]);
  expect(retained.sort((x, y) => Number(x[1]) - Number(y[1]))).toEqual([
    ["rejected", 1],
    ["blocked", 2],
  ]);
  const table = room.authority.getTable();
  expect(table.get("N")?.props["label"]).toBe("rival"); // never applied over nonexistent/foreign state
  expect(table.get(ROOT_ID)?.props["title"]).toBe("independent");
  expect(client.getSnapshot().table.get("N")?.props["label"]).toBe("rival");
});

test("P03 Conflicting duplicate identity", () => {
  const base = listDoc({ x: 0, items: [] });
  const auth = Authority.create(DOC, EPOCH, base);
  const original = envelope(
    "replica-c1",
    1,
    0,
    build(base, "replica-c1", 1, (b) => b.set(ROOT_ID, "x", 1)),
  );
  const first = auth.submit(original, { actor: "c1" });
  expect(() =>
    auth.submit(
      envelope(
        "replica-c1",
        1,
        0,
        build(base, "replica-c1", 1, (b) => b.set(ROOT_ID, "x", 2)),
      ),
      { actor: "c1" },
    ),
  ).toThrow(ProtocolError);
  expect(auth.submit(original, { actor: "c1" }) as unknown).toEqual({ ...first, duplicate: true });
  const bad = envelope("replica-c1", 2, 0, [
    {
      kind: "arrayDelete",
      node: ROOT_ID,
      path: ["items"],
      index: 0,
      values: ["z"],
      origin: { replica: "replica-c1", seq: 2, ordinal: 0 },
    },
  ]);
  const rejected = auth.submit(bad, { actor: "c1" });
  expect(rejected.kind === "decided" && rejected.receipt.outcome).toBe("rejected");
  expect(auth.submit(bad, { actor: "c1" }) as unknown).toEqual({ ...rejected, duplicate: true });
  expect(auth.getRevision()).toBe(1);
});

test("P04 Reconnect after history loss", () => {
  const room = new Room(textDoc("ab"));
  const stale = room.join("stale", "replica-s");
  const active = room.join("active", "replica-a");
  stale.transact((b) => b.textInsert("t", 1, "local"));
  for (const ch of ["1", "2", "3"]) {
    active.transact((b) => b.textInsert("t", 0, ch));
    room.send("active");
    room.deliver("active");
  }
  room.authority.pruneTransitionsThrough(2);
  const decision = room.send("stale");
  expect(decision?.kind).toBe("resync");
  expect(textOf(room.authority.getTable().get("t"))).toBe("321ab"); // no guessed transform
  stale.resync(
    room.authority.getTable(),
    room.authority.getRevision(),
    decision?.kind === "resync" ? decision.reason : "",
  );
  expect(stale.getStatus().retained).toEqual([
    expect.objectContaining({
      status: "resync",
      working: [expect.objectContaining({ text: "local" })],
    }),
  ]);
  expect(textOf(stale.getSnapshot().table.get("t"))).toBe("321ab");
  // Retrying the kept intent is a new request with a new identity.
  stale.transact((b) => b.textInsert("t", 4, "local"));
  room.settle();
  expect(textOf(room.authority.getTable().get("t"))).toBe("321alocalb");
});

test("P05 Composition is not assumed transform-equivalent", () => {
  const base = textDoc("abcd");
  const first = build(base, "replica-a", 1, (b) => b.textDelete("t", 1, 1));
  const second = build(applyChanges(base, first), "replica-a", 2, (b) => b.textInsert("t", 1, "b"));
  // Composition is sequential-equivalent...
  const composite = compose(first, second);
  expect(textOf(applyChanges(base, composite).get("t"))).toBe("abcd");
  // ...but not transform-equivalent to the net-zero it resembles: a concurrent insertion is placed by
  // the retained boundaries, so the accepted log keeps both parts rather than a compressed shortcut.
  const concurrent = build(base, "replica-z", 1, (b) => b.textInsert("t", 2, "Z"));
  const rebased = rebase(concurrent, composite);
  if (isConflict(rebased)) throw new Error("compatible");
  expect(textOf(applyChanges(applyChanges(base, composite), rebased).get("t"))).toBe("abZcd");
  expect(composite).toHaveLength(2);
  const auth = Authority.create(DOC, EPOCH, base);
  auth.submit(envelope("replica-a", 1, 0, first), { actor: "a" });
  auth.submit(envelope("replica-a", 2, 1, second), { actor: "a" });
  expect(auth.transitionsSince(0)).toHaveLength(2);
});

test("P06 Snapshot replay and undo boundary", () => {
  const room = new Room(listDoc({ count: 0, x: 0 }));
  const own = room.join("own", "replica-o");
  const other = room.join("other", "replica-r");
  own.transact((b) => b.delta(ROOT_ID, "count", 5));
  other.transact((b) => b.set(ROOT_ID, "count", 5)); // rejected: set/add on one field
  room.send("own");
  room.send("other");
  room.settle();
  other.transact((b) => b.set(ROOT_ID, "x", 1));
  room.settle();
  // Replay from the initial snapshot through the accepted history reproduces the state; rejected
  // receipts and repeated delivery contribute nothing.
  let replay = listDoc({ count: 0, x: 0 });
  for (const transition of room.authority.transitionsSince(0) ?? [])
    replay = applyChanges(replay, transition.changes);
  expect(replay.get(ROOT_ID)?.props).toEqual(room.authority.getTable().get(ROOT_ID)?.props);
  // Collaborative undo after remote edits is supported and rebased, never an old inverse over newer work.
  expect(own.undo().status).toBe("requested");
  room.settle();
  expect(room.authority.getTable().get(ROOT_ID)?.props).toEqual({ count: 0, x: 1 });
  // A diff back to the pre-action snapshot would have erased the later remote x=1.
  expect(listDoc({ count: 0, x: 0 }).get(ROOT_ID)?.props).not.toEqual(
    room.authority.getTable().get(ROOT_ID)?.props,
  );
  const undo = room.authority.transitionsSince(0)?.at(-1);
  expect(undo?.meta.undoOf).toBe(room.authority.transitionsSince(0)?.[0]?.meta.group);
  expect(invertChanges(undo?.changes ?? ([] as Change[]))).toMatchObject([
    { kind: "delta", by: 5 },
  ]);
});
