import { describe, expect, test } from "bun:test";
import type { ClientSession } from "../../src/core/client.ts";
import { captureBootstrap, joinClient } from "../../src/core/join.ts";
import type { SessionStore } from "../../src/core/join.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { ROOT_ID } from "../../src/core/table.ts";
import {
  allocator,
  content,
  firstRun,
  joinDoc,
  joinRef,
  joinSchema,
} from "../support/join-fixture.ts";
import { envelope } from "../support/requests.ts";
import { Room } from "../support/room.ts";

/** An in-memory, asynchronous actor-scoped session store (the host port a real app would back). */
class MemorySessions implements SessionStore {
  private readonly saved = new Map<string, string>();
  load(documentId: string, actor: string): Promise<ClientSession | undefined> {
    const raw = this.saved.get(`${documentId}/${actor}`);
    return Promise.resolve(raw === undefined ? undefined : (JSON.parse(raw) as ClientSession));
  }
  save(session: ClientSession): Promise<void> {
    this.saved.set(`${session.documentId}/${session.actor}`, JSON.stringify(session));
    return Promise.resolve();
  }
}

/** Alice authors three separate groups (text, list, move); bob adds compatible work. */
function historyRoom(): Room {
  const room = new Room(joinDoc(), { schema: joinSchema });
  const alice = room.join("alice", "replica-a");
  const bob = room.join("bob", "replica-b");
  const table = room.authority.getTable();
  alice.transact((b) => b.textInsert(firstRun(table, "p1"), 0, "A:"));
  alice.closeGroup();
  room.settle();
  bob.transact((b) => b.set("p2", "tags", ["x"]));
  room.settle();
  alice.transact((b) => b.arrayInsert("p2", ["tags"], 1, ["t", "t"]));
  alice.closeGroup();
  room.settle();
  alice.transact((b) => b.moveNode("p3", ROOT_ID, 0));
  alice.closeGroup();
  room.settle();
  bob.transact((b) => b.textInsert(firstRun(table, "p1"), 5, "B"));
  room.settle();
  return room;
}

describe("MR29–MR31 history restoration and permissions", () => {
  test("MR29 Pre-snapshot own undo/redo with retained handles after pruning", async () => {
    const room = historyRoom();
    const store = new MemorySessions();
    const v = room.authority.getRevision();
    await store.save(room.client("alice").exportSession());
    // The authority retires every transition through V: the genesis prefix is gone.
    room.authority.pruneTransitionsThrough(v);
    expect(room.authority.transitionsSince(0)).toBeUndefined();
    // Later compatible work by bob (V → W).
    const bob = room.client("bob");
    bob.transact((b) => b.textInsert(firstRun(room.authority.getTable(), "p2"), 0, "b-"));
    room.settle();
    bob.transact((b) => b.arrayInsert("p2", ["tags"], 3, ["b"]));
    room.settle();
    // Restart: a fresh client from snapshot W, the tail V..W, and alice's stored own history.
    const restored = await store.load("doc-1", "alice");
    if (restored === undefined) throw new Error("session missing");
    const alice2 = room.adopt(
      "alice2",
      "alice",
      joinClient({
        bootstrap: captureBootstrap(room.authority, joinRef),
        transitions: room.authority.transitionsSince(v) ?? [],
        restore: restored,
        schema: joinSchema,
        allocator: allocator("replica-a2"),
        actor: "alice",
      }),
    );
    expect(alice2.getStatus().history).toEqual({ status: "restored", revision: v });
    expect(alice2.history.list().map((g) => g.state)).toEqual(["active", "active", "active"]);
    const [text, list, move] = alice2.history.list();
    // Undo the older text group: bob's later "B" inside the same run survives.
    expect(alice2.undo(text?.id)).toMatchObject({ status: "requested" });
    room.settle();
    const p1 = () =>
      room.authority.getTable().get(firstRun(room.authority.getTable(), "p1"))?.props["value"];
    expect(p1()).toBe("helBlo ");
    // Undo the list group: alice's two "t" occurrences go, bob's "x" and appended "b" stay.
    expect(alice2.undo(list?.id)).toMatchObject({ status: "requested" });
    room.settle();
    expect(room.authority.getTable().get("p2")?.props["tags"]).toEqual(["x", "b"]);
    // Undo the move, then redo it.
    expect(alice2.undo(move?.id)).toMatchObject({ status: "requested" });
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["p1", "p2", "p3"]);
    expect(alice2.redo(move?.id)).toMatchObject({ status: "requested" });
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["p3", "p1", "p2"]);
    expect(p1()).toBe("helBlo ");
    for (const name of ["alice2", "bob"])
      expect(content(room.client(name).getSnapshot().table)).toEqual(
        content(room.authority.getTable()),
      );
    // Nothing fetched the pruned prefix: the horizon never moved back.
    expect(room.authority.retainedFrom()).toBe(v);
  });

  test("MR30 Stale session versus a newer snapshot", () => {
    const room = historyRoom();
    const alice = room.client("alice");
    const run = firstRun(room.authority.getTable(), "p2");
    // Alice at U: one request in flight (submitted, not yet acknowledged) and one unsent.
    alice.transact((b) => b.textInsert(run, 0, "1"));
    alice.closeGroup();
    const inFlight = alice.nextRequest();
    alice.transact((b) => b.textInsert(run, 0, "2"));
    alice.closeGroup();
    const session = alice.exportSession();
    const u = session.revision;
    // The authority accepts the in-flight original and bob's work: U → V.
    room.submit("alice", inFlight);
    room
      .client("bob")
      .transact((b) => b.textInsert(firstRun(room.authority.getTable(), "p1"), 0, "b"));
    room.send("bob");
    const v = room.authority.getRevision();
    expect(v).toBeGreaterThan(u);
    // With context: reconstruct U from V and the tail, attach, and integrate forward.
    const lastSeq = inFlight === undefined ? 0 : inFlight.seq + 1;
    for (const replica of ["replica-a", "replica-a-new"]) {
      const joined = joinClient({
        bootstrap: captureBootstrap(room.authority, joinRef),
        transitions: room.authority.transitionsSince(u) ?? [],
        restore: session,
        schema: joinSchema,
        // The same incarnation continues its persisted sequence; a new incarnation starts fresh.
        allocator: allocator(replica, replica === "replica-a" ? lastSeq : 0),
        actor: "alice",
      });
      expect(joined.getStatus()).toMatchObject({
        confirmedRevision: v,
        history: { status: "restored", revision: u },
      });
      expect(joined.getStatus().unsent).toEqual([{ replica: "replica-a", seq: lastSeq }]);
      // The same visible state the uninterrupted client reaches after the same events.
      room.deliver("alice");
      room.deliver("bob");
      expect(content(joined.getSnapshot().table)).toEqual(content(alice.getSnapshot().table));
      expect(joined.history.list().map((g) => g.id)).toEqual(alice.history.list().map((g) => g.id));
    }
    // The restored unsent original is sent under its original id; a new edit uses the new incarnation.
    const fresh = room.adopt(
      "alice3",
      "alice",
      joinClient({
        bootstrap: captureBootstrap(room.authority, joinRef),
        transitions: room.authority.transitionsSince(u) ?? [],
        restore: session,
        schema: joinSchema,
        allocator: allocator("replica-a3"),
        actor: "alice",
      }),
    );
    fresh.transact((b) => b.textInsert(run, 0, "3"));
    room.members.delete("alice");
    room.settle();
    expect(room.authority.getTable().get(run)?.props["value"]).toBe("321second");
    expect(fresh.undo()).toMatchObject({ status: "requested" });
    room.settle();
    expect(room.authority.getTable().get(run)?.props["value"]).toBe("21second");
    // Without context: history is reported unavailable and pending work is retained, not guessed.
    const blind = joinClient({
      bootstrap: captureBootstrap(room.authority, joinRef),
      restore: session,
      schema: joinSchema,
      allocator: allocator("replica-a4"),
      actor: "alice",
    });
    expect(blind.getStatus().history).toEqual({
      status: "unavailable",
      reason: "session context is not retained",
    });
    expect(blind.getStatus().retained.map((r) => [r.status, r.id.seq])).toEqual([
      ["resync", inFlight?.seq ?? 0],
      ["resync", lastSeq],
    ]);
    expect(blind.undo()).toEqual({ status: "unavailable" });
    expect(content(blind.getSnapshot().table)).toEqual(content(room.authority.getTable()));
  });

  test("MR31 History delivery and permissions", async () => {
    const room = historyRoom();
    const store = new MemorySessions();
    await store.save(room.client("alice").exportSession());
    const bootstrap = captureBootstrap(room.authority, joinRef);
    const saved = await store.load("doc-1", "alice");
    if (saved === undefined) throw new Error("session missing");
    // Another participant cannot adopt alice's history by holding her session or the snapshot.
    expect(() =>
      joinClient({
        bootstrap,
        restore: saved,
        schema: joinSchema,
        allocator: allocator("replica-m"),
        actor: "mallory",
      }),
    ).toThrow(ProtocolError);
    const mallory = room.adopt(
      "mallory",
      "mallory",
      joinClient({
        bootstrap,
        schema: joinSchema,
        allocator: allocator("replica-m"),
        actor: "mallory",
      }),
    );
    expect(mallory.undo()).toEqual({ status: "unavailable" });
    // A hand-built undo naming alice's group is refused by the authority (not ordinary own undo).
    const group = saved.history.groups[0]?.id ?? "";
    const forged = envelope("replica-m", 1, room.authority.getRevision(), [], { undoOf: group });
    expect(room.submit("mallory", forged)).toMatchObject({
      receipt: { outcome: "rejected", reason: "not authorized" },
    });
    // The snapshot carries no receipts, ledger, transitions, or other actors' inverse payloads.
    const wire = JSON.stringify(bootstrap);
    for (const key of ['"ledger"', '"transitions"', '"receipts"', '"before"', '"undo"'])
      expect(wire.includes(key)).toBe(false);
    // Alice on a new device restores her own persisted handles through the port.
    const device = room.adopt(
      "alice-phone",
      "alice",
      joinClient({
        bootstrap,
        restore: saved,
        schema: joinSchema,
        allocator: allocator("replica-p"),
        actor: "alice",
      }),
    );
    expect(device.undo()).toMatchObject({ status: "requested" });
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["p1", "p2", "p3"]);
    // Without stored handles a new device has no historic undo (documented, not fabricated).
    const bare = joinClient({
      bootstrap,
      schema: joinSchema,
      allocator: allocator("replica-q"),
      actor: "alice",
    });
    expect(bare.getStatus().history).toEqual({ status: "empty" });
    expect(bare.undo()).toEqual({ status: "unavailable" });
    // A session saved under another schema interpretation does not attach.
    expect(() =>
      joinClient({
        bootstrap,
        restore: { ...saved, schema: { id: joinRef.id, version: "1.0.0" } },
        schema: joinSchema,
        allocator: allocator("replica-r"),
        actor: "alice",
      }),
    ).toThrow("different schema");
  });
});
