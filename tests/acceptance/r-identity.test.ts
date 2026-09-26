import { describe, expect, test } from "bun:test";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { exportCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { compareOrigin, invertChanges } from "../../src/core/change.ts";
import { canonicalJson } from "../../src/core/change-codec.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { Client } from "../../src/core/client.ts";
import {
  IdentityError,
  isReplicaId,
  MAX_SEQUENCE,
  SequenceAllocator,
} from "../../src/core/identity.ts";
import type { AllocatorState, AllocatorStore } from "../../src/core/identity.ts";
import { schemaInvariants } from "../../src/core/invariants.ts";
import { decodeRequest, ProtocolError } from "../../src/core/protocol.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import { childrenDoc, items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };

function memoryStore(initial?: unknown): AllocatorStore & { saved: AllocatorState[] } {
  const saved: AllocatorState[] = [];
  return { saved, load: () => saved.at(-1) ?? initial, save: (state) => void saved.push(state) };
}

function outcome(decision: Decision): string {
  return decision.kind === "decided" ? decision.receipt.outcome : decision.kind;
}

describe("R45–R49 identity, context, placement, and finality", () => {
  test("R45 Replica-scoped identity without server or wall-clock allocation", () => {
    const table = textDoc("ab");
    const tab = (replica: string) =>
      new Client({
        documentId: DOC,
        historyEpoch: EPOCH,
        allocator: SequenceAllocator.ephemeral(replica),
        actor: "alice",
        table,
        revision: 0,
        now: () => 5,
      });
    const one = tab("tab-1");
    const two = tab("tab-2");
    const r1 = one.transact((b) => b.textInsert("t", 1, "x"));
    const r2 = two.transact((b) => b.textInsert("t", 1, "y"));
    if (r1.status !== "applied" || r2.status !== "applied") throw new Error("setup");
    expect(r1.request).toEqual({ replica: "tab-1", seq: 1 });
    expect(r2.request).toEqual({ replica: "tab-2", seq: 1 });
    expect(r1.group).not.toBe(r2.group); // same actor, same timestamp, separate undo groups

    // Persisted allocator: write-ahead, restart continues; lost state starts a new incarnation.
    const store = memoryStore();
    let incarnations = 0;
    const fresh = () => `inc-${++incarnations}`;
    const first = SequenceAllocator.open(store, fresh);
    expect([first.next(), first.next(), first.next()]).toEqual([1, 2, 3]);
    const restarted = SequenceAllocator.open(store, fresh);
    expect(restarted.replica).toBe(first.replica);
    expect(restarted.next()).toBe(4);
    const lost = SequenceAllocator.open(memoryStore(), fresh);
    expect(lost.replica).not.toBe(first.replica);
    expect(lost.next()).toBe(1);
    expect(() =>
      SequenceAllocator.open(memoryStore({ replica: "inc-1", lastSeq: "3" }), fresh),
    ).toThrow(IdentityError);
    expect(() =>
      SequenceAllocator.open(memoryStore({ replica: "bad id!", lastSeq: 1 }), fresh),
    ).toThrow(IdentityError);
    expect(() => SequenceAllocator.ephemeral("edge", MAX_SEQUENCE).next()).toThrow(IdentityError);

    // Canonical encoding and comparison: bounded ASCII compared bytewise; sequences numerically.
    expect(isReplicaId("replica-a")).toBe(true);
    for (const bad of ["", "ä", "a b", "x".repeat(65)]) expect(isReplicaId(bad)).toBe(false);
    const origin = (replica: string, seq: number) => ({ replica, seq, ordinal: 0 });
    expect(compareOrigin(origin("B", 1), origin("a", 1))).toBeLessThan(0);
    expect("B".localeCompare("a")).toBeGreaterThan(0); // a locale comparator would order these differently
    expect(compareOrigin(origin("r", 9), origin("r", 10))).toBeLessThan(0);
    for (const seq of [0, 1.5, "3", -1])
      expect(() => decodeRequest({ ...envelope("r", 1, 0, []), seq })).toThrow(ProtocolError);

    // A saved in-flight request retries with its original identity and bytes; gaps are harmless.
    const room = new Room(textDoc("ab"));
    const author = room.join("a", "replica-a");
    author.transact((b) => b.textInsert("t", 1, "x"));
    author.transact((b) => b.textInsert("t", 0, "!")); // not adjacent: separate request
    const sent = author.nextRequest();
    const cancelled = author.getStatus().unsent[0];
    if (cancelled !== undefined) author.cancel(cancelled); // a local sequence gap
    const session = author.exportSession();
    const revived = new Client({
      documentId: DOC,
      historyEpoch: EPOCH,
      allocator: SequenceAllocator.ephemeral("replica-a", 2),
      actor: "a",
      table: room.authority.getTable(),
      revision: 0,
      restore: session,
    });
    expect(canonicalJson(revived.resend())).toBe(canonicalJson(sent));
    room.submit("a", revived.resend());
    revived.receive(room.member("a").inbox.splice(0));
    expect(textOf(revived.getSnapshot().table.get("t"))).toBe("axb");
    const next = revived.transact((b) => b.textInsert("t", 0, "n"));
    expect(next.status === "applied" && next.request.seq).toBe(3); // never reuses a retired sequence
  });

  test("R46 Authored, submitted, working, and accepted forms retain their roles", () => {
    const room = new Room(textDoc("abcd"));
    const author = room.join("a", "replica-a");
    const other = room.join("b", "replica-b");
    author.transact((b) => b.textInsert("t", 2, "X"));
    author.transact((b) => b.textInsert("t", 3, "Y")); // packed typing keeps the first stable origin
    other.transact((b) => b.textInsert("t", 0, ">"));
    room.send("b");
    room.deliver("a"); // remote before sending: unsent form rebased
    const entry = author.state.pending[0];
    expect(entry?.meta.authoredRevision).toBe(0);
    expect(entry?.working).toEqual([
      expect.objectContaining({
        offset: 3,
        text: "XY",
        origin: { replica: "replica-a", seq: 1, ordinal: 0 },
      }),
    ]);
    const sent = author.nextRequest();
    expect(sent?.baseRevision).toBe(1);
    const bytes = canonicalJson(sent);
    room.deliver("b");
    other.transact((b) => b.textDelete("t", 1, 4)); // deletes a,b,c,d around the in-flight insertion
    room.send("b");
    room.deliver("a"); // while in flight: the working form is rebased, the sent bytes are not
    expect(canonicalJson(author.resend())).toBe(bytes);
    expect(author.state.pending[0]?.working[0]).toMatchObject({ offset: 1 });
    room.submit("a", sent);
    room.settle();
    const accepted = room.authority.transitionsSince(0) ?? [];
    const own = accepted.find((t) => t.request.replica === "replica-a");
    expect(own?.revision).toBe(3);
    expect(own?.meta.authoredRevision).toBe(0); // accepted position is not the author's read base
    expect(textOf(room.authority.getTable().get("t"))).toBe(">XY");
    // The concurrent deletion expanded into two pieces that keep one origin and invert from the record alone.
    const deletion = accepted.find((t) => t.changes.some((c) => c.kind === "textDelete"));
    expect(new Set(deletion?.changes.map((c) => canonicalJson(c.origin))).size).toBe(1);
    const expanded = transformPair(
      build(textDoc("abcd"), "replica-b", 9, (b) => b.textDelete("t", 1, 3)),
      build(textDoc("abcd"), "replica-a", 1, (b) => b.textInsert("t", 2, "XY")),
    );
    if (isConflict(expanded)) throw new Error("compatible");
    expect(expanded.a).toHaveLength(2);
    expect(expanded.a.every((c) => c.origin.seq === 9)).toBe(true);
    const branch = applyChanges(
      textDoc("abcd"),
      build(textDoc("abcd"), "replica-a", 1, (b) => b.textInsert("t", 2, "XY")),
    );
    const roundTrip = JSON.parse(JSON.stringify(expanded.a)) as typeof expanded.a;
    expect(
      textOf(applyChanges(applyChanges(branch, roundTrip), invertChanges(roundTrip)).get("t")),
    ).toBe("abXYcd");
    // Undo/redo use new request identities linked to the original group.
    author.undo();
    const undo = author.nextRequest();
    expect(undo?.seq).not.toBe(sent?.seq);
    expect(undo?.meta.undoOf).toBe(sent?.meta.group);
  });

  test("R47 Causal dependencies are not a sorted order of identifiers", () => {
    const base = textDoc("ab");
    const auth = Authority.create(DOC, EPOCH, base);
    auth.submit(
      envelope(
        "replica-z",
        1,
        0,
        build(base, "replica-z", 1, (b) => b.textInsert("t", 1, "X")),
      ),
      { actor: "z" },
    );
    auth.submit(
      envelope(
        "replica-a",
        1,
        0,
        build(base, "replica-a", 1, (b) => b.textInsert("t", 2, "Y")),
        { authoredAt: 0 },
      ),
      { actor: "a" },
    );
    // Y was authored at base 0 (after "b"), so it lands after b, not where index 2 would be in "aXb".
    expect(textOf(auth.getTable().get("t"))).toBe("aXbY");
    // A later request that observed X depends on it even though its replica id sorts first.
    const kids = Authority.create(DOC, EPOCH, childrenDoc(["A"]));
    kids.submit(
      envelope(
        "replica-z",
        1,
        0,
        build(
          kids.getTable(),
          "replica-z",
          1,
          (b) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "N", props: { label: "n" } }),
        ),
      ),
      { actor: "z" },
    );
    const dependent = kids.submit(
      envelope(
        "replica-a",
        1,
        1,
        build(kids.getTable(), "replica-a", 1, (b) => b.set("N", "label", "seen")),
      ),
      { actor: "a" },
    );
    expect(outcome(dependent)).toBe("applied");
    expect(kids.getTable().get("N")?.props["label"]).toBe("seen");

    // Several optimistic predecessors, a rejected predecessor, and recovery with skewed clocks.
    let clock = 1_000;
    const room = new Room(listDoc({ x: 0, title: "t" }));
    const client = room.join("c", "replica-c", "c", { now: () => (clock -= 100) });
    const rival = room.join("r", "replica-r");
    client.transact(
      (b) => void b.insertNode(ROOT_ID, 0, { tag: "item", id: "C1", props: { label: "c" } }),
    );
    client.closeGroup();
    client.transact((b) => b.set("C1", "label", "dependent"));
    client.closeGroup();
    client.transact((b) => b.set(ROOT_ID, "title", "independent"));
    rival.transact(
      (b) => void b.insertNode(ROOT_ID, 0, { tag: "item", id: "C1", props: { label: "taken" } }),
    );
    room.send("r");
    room.send("c");
    room.settle();
    expect(
      client
        .getStatus()
        .retained.map((r) => r.status)
        .sort(),
    ).toEqual(["blocked", "rejected"]);
    expect(room.authority.getTable().get(ROOT_ID)?.props["title"]).toBe("independent");
    expect(room.authority.getTable().get("C1")?.props["label"]).toBe("taken");
  });

  test("R48 Same-gap insertion order is independent of admission and delivery", () => {
    const base = textDoc("ab");
    const ins = (replica: string, text: string) =>
      build(base, replica, 1, (b) => b.textInsert("t", 1, text));
    const x = ins("replica-a", "X");
    const y = ins("replica-b", "Y");
    const both = transformPair(x, y);
    const reverse = transformPair(y, x);
    if (isConflict(both) || isConflict(reverse)) throw new Error("compatible");
    expect(textOf(applyChanges(applyChanges(base, y), both.a).get("t"))).toBe("aXYb");
    expect(textOf(applyChanges(applyChanges(base, x), both.b).get("t"))).toBe("aXYb");
    expect(textOf(applyChanges(applyChanges(base, x), reverse.a).get("t"))).toBe("aXYb");
    const contenders = [
      ["replica-a", "X"],
      ["replica-b", "Y"],
      ["replica-c", "W"],
    ] as const;
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const room = new Room(base);
      for (const [replica] of contenders) room.join(replica, replica);
      for (const i of order) {
        const [replica, text] = contenders[i] as (typeof contenders)[number];
        room.client(replica).transact((b) => b.textInsert("t", 1, text));
      }
      for (const i of order) room.send((contenders[i] as (typeof contenders)[number])[0]);
      room.settle();
      const accepted = room.authority.transitionsSince(0)?.map((t) => t.request.replica);
      expect(accepted).toEqual(order.map((i) => (contenders[i] as (typeof contenders)[number])[0]));
      for (const [replica] of contenders)
        expect(textOf(room.client(replica).getSnapshot().table.get("t"))).toBe("aXYWb");
    }
    // Arrays and child lists with equal-looking values; a case-sensitive id is compared bytewise.
    const list = listDoc({ items: ["a", "b"] });
    for (const order of [
      ["replica-a", "replica-B"],
      ["replica-B", "replica-a"],
    ]) {
      const auth = Authority.create(DOC, EPOCH, list);
      order.forEach((replica) =>
        auth.submit(
          envelope(
            replica,
            1,
            0,
            build(list, replica, 1, (b) => b.arrayInsert(ROOT_ID, ["items"], 1, ["same"])),
          ),
          { actor: replica },
        ),
      );
      expect(items(auth.getTable())).toEqual(["a", "same", "same", "b"]);
      expect(auth.transitionsSince(0)?.map((t) => t.changes[0]?.origin.replica)).toEqual(order);
    }
    // Composition and a checkpoint restart keep origins; Z placed between X and Y stays addressed.
    const room = new Room(base);
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    a.transact((w) => w.textInsert("t", 1, "X"));
    a.transact((w) => w.textInsert("t", 2, "x")); // packed with X, keeps origin seq 1
    b.transact((w) => w.textInsert("t", 1, "Y"));
    room.send("b");
    room.settle();
    expect(textOf(room.authority.getTable().get("t"))).toBe("aXxYb");
    const restored = restoreAuthority(exportCheckpoint(room.authority, SCHEMA), [], SCHEMA);
    restored.submit(
      envelope(
        "replica-0",
        1,
        restored.getRevision(),
        build(restored.getTable(), "replica-0", 1, (w) => w.textInsert("t", 3, "Z")),
      ),
      { actor: "zero" },
    );
    expect(textOf(restored.getTable().get("t"))).toBe("aXxZYb");
  });

  test("R49 Invariant and incompatible-write outcomes remain final", () => {
    const base = listDoc({ items: ["a", "b"], x: 0 });
    const decide = (first: "a" | "b") => {
      const room = new Room(base, { validators: [schemaInvariants(listSchema)] });
      const low = room.join("low", "replica-a");
      const high = room.join("high", "replica-b");
      const watcher = room.join("watch", "replica-w");
      low.transact((w) => w.arrayDelete(ROOT_ID, ["items"], 0));
      high.transact((w) => w.arrayDelete(ROOT_ID, ["items"], 1));
      if (first === "b") room.send("high");
      room.send("low");
      room.send("high");
      room.settle();
      for (const client of [low, high, watcher])
        expect(items(client.getSnapshot().table)).toEqual(first === "b" ? ["a"] : ["b"]);
      return room;
    };
    const bFirst = decide("b");
    expect(bFirst.decisions.map(outcome)).toEqual(["applied", "rejected"]);
    expect(decide("a").decisions.map(outcome)).toEqual(["applied", "rejected"]);
    // A later authorized undo is a new decision; the old receipt stays applied.
    const high = bFirst.client("high");
    high.undo();
    bFirst.settle();
    expect(items(bFirst.authority.getTable())).toEqual(["a", "b"]);
    const original = bFirst.authority.transitionsSince(0)?.[0];
    const replay = bFirst.authority.submit(
      envelope("replica-b", 1, 0, original?.changes ?? [], original?.meta),
      { actor: "high" },
    );
    expect(replay.kind === "decided" && replay.receipt.outcome).toBe("applied");
    // Same-field assignments: first admitted wins; the later one is rejected, not merged.
    const fields = Authority.create(DOC, EPOCH, base);
    expect(
      outcome(
        fields.submit(
          envelope(
            "replica-b",
            1,
            0,
            build(base, "replica-b", 1, (w) => w.set(ROOT_ID, "x", 2)),
          ),
          { actor: "b" },
        ),
      ),
    ).toBe("applied");
    expect(
      outcome(
        fields.submit(
          envelope(
            "replica-a",
            1,
            0,
            build(base, "replica-a", 1, (w) => w.set(ROOT_ID, "x", 1)),
          ),
          { actor: "a" },
        ),
      ),
    ).toBe("rejected");
    expect(
      outcome(
        fields.submit(
          envelope(
            "replica-c",
            1,
            0,
            build(base, "replica-c", 1, (w) => w.set(ROOT_ID, "x", 2)),
          ),
          { actor: "c" },
        ),
      ),
    ).toBe("alreadySatisfied");
  });
});
