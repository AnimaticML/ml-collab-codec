import { describe, expect, test } from "bun:test";
import { exportCheckpoint, importCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import {
  beginJoin,
  bootstrapFromCheckpoint,
  captureBootstrap,
  joinClient,
  readBootstrap,
} from "../../src/core/join.ts";
import type { ServerEvent, TransitionEvent } from "../../src/core/protocol.ts";
import { SnapshotError } from "../../src/core/snapshot-rows.ts";
import { ROOT_ID, TEXT_TAG } from "../../src/core/table.ts";
import {
  allocator,
  content,
  firstRun,
  joinDoc,
  joinRef,
  joinSchema,
  viaJson,
} from "../support/join-fixture.ts";
import type { MutableRows } from "../support/join-fixture.ts";
import { Room } from "../support/room.ts";

/** A room at revision 4 with two writers and settled clients. */
function busyRoom(): Room {
  const room = new Room(joinDoc(), { schema: joinSchema });
  const alice = room.join("alice", "replica-a");
  const bob = room.join("bob", "replica-b");
  const table = room.authority.getTable();
  alice.transact((b) => b.textInsert(firstRun(table, "p1"), 0, "A:"));
  room.settle();
  bob.transact((b) => b.textInsert(firstRun(table, "p2"), 6, "!"));
  room.settle();
  alice.transact((b) => b.moveNode("p3", ROOT_ID, 0));
  room.settle();
  bob.transact((b) => b.set("p2", "tags", ["x", "x"]));
  room.settle();
  return room;
}

describe("MR25–MR28 snapshot-based join", () => {
  test("MR25 Snapshot is state, not genesis replay", () => {
    const room = busyRoom();
    const v = room.authority.getRevision();
    expect(v).toBe(4);
    for (const retained of [0, 2]) {
      // Serialized through JSON, restored on a "new host" with no original process objects.
      const bundle = viaJson(exportCheckpoint(room.authority, joinRef, retained));
      const restored = restoreAuthority(bundle, [], joinSchema);
      expect(restored.getRevision()).toBe(v);
      expect(content(restored.getTable())).toEqual(content(room.authority.getTable()));
      // Retained transitions ending at V are late-rebase context only; they were not reapplied.
      expect(restored.retainedFrom()).toBe(v - retained);
      expect(bundle.transitions).toHaveLength(retained);
    }
    // Internal text/anonymous handles from the snapshot remain addressable after restore.
    const restored = restoreAuthority(exportCheckpoint(room.authority, joinRef), [], joinSchema);
    const emphasis = restored
      .getTable()
      .get("p1")
      ?.children.find((id) => restored.getTable().get(id)?.tag === "emphasis");
    const inner = restored.getTable().get(emphasis ?? "")?.children[0] ?? "";
    expect(restored.getTable().get(inner)?.tag).toBe(TEXT_TAG);
    const carol = joinClient({
      bootstrap: captureBootstrap(restored, joinRef),
      schema: joinSchema,
      allocator: allocator("replica-c"),
      actor: "carol",
    });
    carol.transact((b) => b.textInsert(inner, 3, "ger"));
    const decision = restored.submit(carol.nextRequest(), { actor: "carol" });
    expect(decision).toMatchObject({ receipt: { outcome: "applied" } });
    expect(restored.getTable().get(inner)?.props["value"]).toBe("bigger");
    // State and scope metadata validate before anything is published.
    const bad = viaJson(exportCheckpoint(room.authority, joinRef)) as unknown as MutableRows;
    const p2 = bad.rows.find((row) => row.id === "p2");
    if (p2 !== undefined) p2.props["tags"] = [42];
    expect(() => restoreAuthority(bad, [], joinSchema)).toThrow(SnapshotError);
    expect(() =>
      importCheckpoint(exportCheckpoint(room.authority, joinRef), { ...joinRef, version: "9" }),
    ).toThrow("schema differs");
  });

  test("MR26 Fresh join at a current nonzero snapshot", () => {
    const room = busyRoom();
    const before = { table: room.authority.getTable(), revision: room.authority.getRevision() };
    const aliceStatus = room.client("alice").getStatus();
    const bootstrap = captureBootstrap(room.authority, joinRef);
    // Capturing mutates nothing: authority state and existing clients are untouched.
    expect(room.authority.getTable()).toBe(before.table);
    expect(room.client("alice").getStatus()).toEqual(aliceStatus);
    expect(Object.keys(bootstrap).sort()).toEqual([
      "documentId",
      "format",
      "historyEpoch",
      "opFormat",
      "profile",
      "revision",
      "rows",
      "schema",
      "scope",
    ]);
    const carol = room.adopt(
      "carol",
      "carol",
      joinClient({
        bootstrap,
        schema: joinSchema,
        allocator: allocator("replica-c"),
        actor: "carol",
      }),
    );
    expect(carol.state.revision).toBe(4);
    expect(content(carol.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    expect(carol.getStatus().history).toEqual({ status: "empty" });
    expect(carol.undo()).toEqual({ status: "unavailable" });
    carol.transact((b) => b.textInsert(firstRun(room.authority.getTable(), "p3"), 0, "C:"));
    room.settle();
    expect(carol.undo()).toMatchObject({ status: "requested" });
    room.settle();
    expect(
      room.authority.getTable().get(firstRun(room.authority.getTable(), "p3"))?.props["value"],
    ).toBe("third");
    // Existing participants keep their own history.
    expect(room.client("alice").undo()).toMatchObject({ status: "requested" });
    room.settle();
    expect(content(carol.getSnapshot().table)).toEqual(content(room.authority.getTable()));
  });

  test("MR27 Stored snapshot plus nonempty tail and a live race", () => {
    const room = busyRoom();
    const stored = viaJson(exportCheckpoint(room.authority, joinRef));
    const v = stored.revision;
    const alice = room.client("alice");
    const run = firstRun(room.authority.getTable(), "p1");
    for (const text of ["1", "2"]) {
      alice.transact((b) => b.textInsert(run, 0, text));
      room.settle();
    }
    // Safe handoff: subscribe (fence) first, then read the stored snapshot and the tail to W.
    const live: TransitionEvent[] = [];
    const stop = room.authority.subscribe((t) => live.push(t));
    const tail = room.authority.transitionsSince(v) ?? [];
    expect(tail.map((t) => t.revision)).toEqual([5, 6]);
    // Events produced while the snapshot is "in transfer".
    alice.transact((b) => b.textInsert(run, 0, "3"));
    room.settle();
    room.client("bob").transact((b) => b.moveNode("p2", ROOT_ID, 0));
    room.settle();
    stop();
    expect(live.map((t) => t.revision)).toEqual([7, 8]);
    const dave = joinClient({
      bootstrap: bootstrapFromCheckpoint(stored),
      schema: joinSchema,
      allocator: allocator("replica-d"),
      actor: "dave",
    });
    const commits: number[] = [];
    dave.subscribeCommits((commit) => commits.push(commit.next.basis.confirmedRevision));
    // Reordered and duplicated catch-up, including events at or below V: each applied once.
    const early = room.authority.transitionsSince(v - 1)?.[0] as ServerEvent;
    dave.receive([tail[1] as ServerEvent, early, tail[0] as ServerEvent, tail[1] as ServerEvent]);
    expect(commits).toEqual([6]);
    // A gap buffers: revision 8 before 7 changes nothing until 7 arrives.
    dave.receive(live[1] as ServerEvent);
    expect(dave.state.revision).toBe(6);
    dave.receive([live[0] as ServerEvent, live[0] as ServerEvent]);
    expect(dave.state.revision).toBe(8);
    expect(content(dave.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    // Subscribing after capture is unsafe: a transition between is missed, the client detects the
    // gap when a later one arrives, and an explicit catch-up from the retained tail repairs it.
    const late = joinClient({
      bootstrap: captureBootstrap(room.authority, joinRef),
      schema: joinSchema,
      allocator: allocator("replica-e"),
      actor: "erin",
    });
    alice.transact((b) => b.textInsert(run, 0, "4"));
    room.settle();
    const after: TransitionEvent[] = [];
    const stopLate = room.authority.subscribe((t) => after.push(t));
    alice.transact((b) => b.textInsert(run, 0, "5"));
    room.settle();
    stopLate();
    late.receive(after);
    expect(late.state.revision).toBe(8);
    late.receive(room.authority.transitionsSince(late.state.revision) ?? []);
    expect(content(late.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    // The fence helper subscribes before capturing.
    const fenced: TransitionEvent[] = [];
    const join = beginJoin(room.authority, joinRef, (t) => fenced.push(t));
    alice.transact((b) => b.textInsert(run, 0, "6"));
    room.settle();
    join.stop();
    const frank = joinClient({
      bootstrap: join.bootstrap,
      schema: joinSchema,
      allocator: allocator("replica-f"),
      actor: "frank",
      transitions: fenced,
    });
    expect(content(frank.getSnapshot().table)).toEqual(content(room.authority.getTable()));
  });

  test("MR28 Join keeps addresses and permits contextual edits during catch-up", () => {
    const room = busyRoom();
    const table = room.authority.getTable();
    const run = firstRun(table, "p1");
    const bootstrap = captureBootstrap(room.authority, joinRef);
    // The bootstrap carries the operational handles, not ids regenerated from source.
    expect(readBootstrap(bootstrap, joinSchema).table.get(run)).toEqual(table.get(run));
    expect(content(readBootstrap(bootstrap, joinSchema).table)).toMatchObject({
      root: { id: "d1" },
    });
    expect(() => readBootstrap(bootstrap, { ...joinRef, version: "2.2.0" })).toThrow(SnapshotError);
    // Concurrently: alice moves p1 and edits its run; the tail is not yet delivered to the joiner.
    const alice = room.client("alice");
    alice.transact((b) => b.moveNode("p1", ROOT_ID, 3).textInsert(run, 2, "[a]"));
    room.settle();
    const gina = room.adopt(
      "gina",
      "gina",
      joinClient({
        bootstrap,
        schema: joinSchema,
        allocator: allocator("replica-g"),
        actor: "gina",
      }),
    );
    // Edit during catch-up, from the known base V, targeting a pre-V run.
    gina.transact((b) => b.textInsert(run, 5, "<g>"));
    room.catchUp("gina");
    room.settle();
    const value = room.authority.getTable().get(run)?.props["value"];
    expect(value).toBe("A:[a]hel<g>lo ");
    expect(content(gina.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    expect(content(alice.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    // An edit that cannot survive (its run was deleted concurrently) is retained, not lost.
    const bootstrap2 = captureBootstrap(room.authority, joinRef);
    alice.transact((b) => b.deleteNode("p2"));
    room.settle();
    const hank = room.adopt(
      "hank",
      "hank",
      joinClient({
        bootstrap: bootstrap2,
        schema: joinSchema,
        allocator: allocator("replica-h"),
        actor: "hank",
      }),
    );
    hank.transact((b) =>
      b.textInsert(firstRun(room.authority.getTable(), "p3"), 0, "?").set("p2", "tags", ["h"]),
    );
    room.catchUp("hank");
    room.settle();
    expect(hank.getStatus().retained).toEqual([expect.objectContaining({ status: "rejected" })]);
    expect(content(hank.getSnapshot().table)).toEqual(content(room.authority.getTable()));
  });
});
