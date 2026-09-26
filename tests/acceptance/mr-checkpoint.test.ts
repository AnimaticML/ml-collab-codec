import { describe, expect, test } from "bun:test";
import { recordOf } from "../../src/core/authority.ts";
import type { DecisionRecord } from "../../src/core/authority.ts";
import { exportCheckpoint, importCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { captureBootstrap, joinClient, readBootstrap } from "../../src/core/join.ts";
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
import { envelope } from "../support/requests.ts";
import { Room } from "../support/room.ts";

type Row = {
  id: string;
  tag: string;
  props: Record<string, unknown>;
  parentId: string | null;
  children: string[];
  persisted: boolean;
  rootId?: string;
};
type Bundle = {
  rows: Row[];
  revision: unknown;
  documentId: unknown;
  transitions: { revision: number; changes: unknown[] }[];
  ledger: { receipts: unknown; replicas: { expiredThrough: unknown }[] };
  format: string;
  profile: string;
};

function editedRoom(): Room {
  const room = new Room(joinDoc(), { schema: joinSchema });
  const alice = room.join("alice", "replica-a");
  const run = firstRun(room.authority.getTable(), "p1");
  for (const text of ["x", "y", "z"]) {
    alice.transact((b) => b.textInsert(run, 0, text));
    room.settle();
  }
  return room;
}

function fresh(room: Room, retain = 2): Bundle {
  return viaJson(exportCheckpoint(room.authority, joinRef, retain)) as unknown as Bundle;
}

const row = (bundle: Bundle, id: string): Row => {
  const found = bundle.rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

describe("MR32–MR33 checkpoint integrity and retention races", () => {
  test("MR32 Corrupt checkpoint rejection", () => {
    const room = editedRoom();
    expect(() => importCheckpoint(fresh(room), joinSchema)).not.toThrow();
    const corruptions: [string, (b: Bundle) => void][] = [
      ["missing root", (b) => (b.rows = b.rows.filter((r) => r.id !== ROOT_ID))],
      [
        "second root",
        (b) => b.rows.push({ ...row(b, "p3"), id: "x9", parentId: null, children: [] }),
      ],
      ["duplicate row id", (b) => b.rows.push({ ...row(b, "p2") })],
      ["absent child", (b) => row(b, ROOT_ID).children.push("ghost")],
      ["inconsistent parent", (b) => (row(b, "p2").parentId = "p1")],
      [
        "self parent cycle",
        (b) => {
          row(b, "p3").children.push("p3");
        },
      ],
      [
        "unreachable cycle",
        (b) => {
          row(b, ROOT_ID).children = row(b, ROOT_ID).children.filter((id) => id !== "p3");
          row(b, "p3").parentId = "p3";
        },
      ],
      [
        "text run with children",
        (b) => {
          const text = b.rows.find((r) => r.tag === TEXT_TAG) as Row;
          text.children = ["p2"];
        },
      ],
      ["invalid schema value", (b) => (row(b, "p2").props = { tags: "not-a-list" })],
      ["unknown tag", (b) => (row(b, "p2").tag = "script")],
      ["rootId on a non-root row", (b) => (row(b, "p2").rootId = "d1")],
      ["negative revision", (b) => (b.revision = -1)],
      ["fractional revision", (b) => (b.revision = 1.5)],
      ["string revision", (b) => (b.revision = "3")],
      ["empty scope", (b) => (b.documentId = "")],
      ["unknown format", (b) => (b.format = "sdl.checkpoint/9")],
      ["unknown profile", (b) => (b.profile = "vector-clock/1")],
      [
        "noncontiguous retained transitions",
        (b) =>
          b.transitions.splice(0, 1, {
            ...(b.transitions[0] as Bundle["transitions"][0]),
            revision: 1,
          }),
      ],
      [
        "retained transitions that do not lead to the state",
        (b) => (row(b, firstRunRow(b)).props = { value: "" }),
      ],
      ["malformed ledger", (b) => (b.ledger.receipts = "none")],
      [
        "malformed replica record",
        (b) => ((b.ledger.replicas[0] as { expiredThrough: unknown }).expiredThrough = -2),
      ],
      [
        "operation expansion",
        (b) =>
          ((b.transitions[1] as { changes: unknown[] }).changes = Array.from(
            { length: 10_001 },
            () => ({}),
          )),
      ],
    ];
    for (const [name, corrupt] of corruptions) {
      const bundle = fresh(room);
      corrupt(bundle);
      expect({ name, thrown: throws(() => restoreAuthority(bundle, [], joinSchema)) }).toEqual({
        name,
        thrown: "SnapshotError",
      });
    }
    // Deep nesting is bounded (no stack exhaustion): a 5000-deep chain is rejected cleanly.
    const deep = fresh(room);
    let parent = ROOT_ID;
    for (let i = 0; i < 5000; i += 1) {
      const id = `deep${i}`;
      row(deep, parent).children.push(id);
      deep.rows.push({ id, tag: "p", props: {}, parentId: parent, children: [], persisted: true });
      parent = id;
    }
    expect(() => importCheckpoint(deep, joinRef)).toThrow("too deep");
    // A noncontiguous decision tail is refused, and a malformed tail record never replays.
    const bundle = fresh(room);
    const tail = futureRecords(room, 2);
    expect(() => restoreAuthority(bundle, [tail[1]], joinSchema)).toThrow("not contiguous");
    expect(() =>
      restoreAuthority(bundle, [{ ...tail[0], receipt: { type: "receipt" } }], joinSchema),
    ).toThrow(SnapshotError);
    // Bootstraps get the same structural checks.
    const boot = viaJson(captureBootstrap(room.authority, joinRef)) as unknown as MutableRows;
    boot.rows.push({ ...(boot.rows[0] as MutableRows["rows"][0]) });
    expect(() => readBootstrap(boot, joinSchema)).toThrow("duplicate row id");
  });

  test("MR33 Retention races and retry boundaries", () => {
    const room = editedRoom();
    const alice = room.client("alice");
    const run = firstRun(room.authority.getTable(), "p1");
    // Prune while a participant is bootstrapping: its tail is gone, so the host re-snapshots.
    const early = captureBootstrap(room.authority, joinRef);
    const v = room.authority.getRevision();
    alice.transact((b) => b.textInsert(run, 0, "1"));
    room.settle();
    room.authority.pruneTransitionsThrough(room.authority.getRevision());
    expect(room.authority.transitionsSince(v)).toBeUndefined();
    const retry = joinClient({
      bootstrap: captureBootstrap(room.authority, joinRef),
      schema: joinSchema,
      allocator: allocator("replica-j"),
      actor: "joiner",
    });
    expect(content(retry.getSnapshot().table)).toEqual(content(room.authority.getTable()));
    // Using the early snapshot without its tail stalls visibly at a gap instead of guessing.
    const stalled = joinClient({
      bootstrap: early,
      schema: joinSchema,
      allocator: allocator("replica-k"),
      actor: "k",
    });
    alice.transact((b) => b.textInsert(run, 0, "2"));
    room.settle();
    stalled.receive(room.authority.transitionsSince(room.authority.getRevision() - 1) ?? []);
    expect(stalled.state.revision).toBe(v);
    // Reconnect past the horizon: an explicit resync, pending work retained, history unavailable.
    const bob = room.join("bob", "replica-b");
    room.members.delete("bob");
    bob.transact((b) => b.textInsert(run, 0, "B"));
    alice.transact((b) => b.textInsert(run, 0, "3"));
    room.settle();
    room.authority.pruneTransitionsThrough(room.authority.getRevision());
    const decision = room.authority.submit(bob.nextRequest(), { actor: "bob" });
    expect(decision.kind).toBe("resync");
    bob.resync(
      room.authority.getTable(),
      room.authority.getRevision(),
      "past the retained horizon",
    );
    expect(bob.getStatus()).toMatchObject({
      history: { status: "unavailable" },
      retained: [{ status: "resync" }],
    });
    // Duplicates of rejected and no-op requests keep their original outcome.
    const ghost = envelope("replica-z", 1, room.authority.getRevision(), [
      {
        kind: "set",
        node: "ghost",
        path: ["x"],
        after: 1,
        origin: { replica: "replica-z", seq: 1, ordinal: 0 },
      },
    ]);
    const bad = envelope("replica-z", 2, room.authority.getRevision(), []);
    const rejected = room.authority.submit(ghost, { actor: "zed" });
    const noop = room.authority.submit(bad, { actor: "zed" });
    expect([rejected, noop].map((d) => d.kind === "decided" && d.receipt.outcome)).toEqual([
      "rejected",
      "alreadySatisfied",
    ]);
    expect(room.authority.submit(ghost, { actor: "zed" })).toMatchObject({
      duplicate: true,
      receipt: { outcome: "rejected" },
    });
    const revision = room.authority.getRevision();
    expect(room.authority.submit(bad, { actor: "zed" })).toMatchObject({
      duplicate: true,
      receipt: { outcome: "alreadySatisfied" },
    });
    expect(room.authority.getRevision()).toBe(revision);
    // Expired receipts never reapply a delta: the retry is a resync.
    room.authority.expireReceiptsThrough(room.authority.getRevision());
    expect(room.authority.submit(bad, { actor: "zed" }).kind).toBe("resync");
    expect(room.authority.getRevision()).toBe(revision);
    // Publication with retention k keeps late rebase, dedup, and own undo capabilities independently.
    const carol = room.join("carol", "replica-c");
    carol.transact((b) => b.textInsert(run, 0, "C"));
    room.settle();
    const withRetention = restoreAuthority(fresh(room, 1), [], joinSchema);
    const base = withRetention.getRevision() - 1;
    expect(withRetention.transitionsSince(base)).toHaveLength(1);
    const late = envelope("replica-l", 1, base, [
      {
        kind: "textInsert",
        node: run,
        offset: 0,
        text: "L",
        origin: { replica: "replica-l", seq: 1, ordinal: 0 },
      },
    ]);
    expect(withRetention.submit(late, { actor: "l" })).toMatchObject({
      receipt: { outcome: "applied" },
    });
    const carolRequest = room.authority.transitionsSince(base)?.[0]?.request;
    expect(withRetention.hasReceipt(carolRequest ?? { replica: "x", seq: 1 })).toBe(true);
    const undo = carol.undo();
    expect(undo).toMatchObject({ status: "requested" });
    expect(withRetention.submit(carol.nextRequest(), { actor: "carol" })).toMatchObject({
      receipt: { outcome: "applied" },
    });
  });
});

function firstRunRow(bundle: Bundle): string {
  return row(bundle, "p1").children.find((id) => row(bundle, id).tag === TEXT_TAG) ?? "";
}

function throws(run: () => unknown): string {
  try {
    run();
    return "nothing";
  } catch (error) {
    return error instanceof Error ? error.constructor.name : typeof error;
  }
}

/** Decision records for `count` further edits made on a scratch copy of the room's authority. */
function futureRecords(room: Room, count: number): DecisionRecord[] {
  const copy = restoreAuthority(exportCheckpoint(room.authority, joinRef), [], joinSchema);
  const run = firstRun(copy.getTable(), "p1");
  const records: DecisionRecord[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    const change = {
      kind: "textInsert" as const,
      node: run,
      offset: 0,
      text: "t",
      origin: { replica: "replica-t", seq, ordinal: 0 },
    };
    const prepared = copy.prepare(envelope("replica-t", seq, copy.getRevision(), [change]), {
      actor: "t",
    });
    copy.install(prepared);
    const record = recordOf(prepared);
    if (record !== undefined) records.push(record);
  }
  return records;
}
