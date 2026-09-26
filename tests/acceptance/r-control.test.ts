import { describe, expect, test } from "bun:test";
import type { ChangeBuilder } from "../../src/core/builder.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import type { Change } from "../../src/core/change.ts";
import { invertChanges } from "../../src/core/change.ts";
import { canonicalJson, decodeChanges } from "../../src/core/change-codec.ts";
import { exportCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { Client } from "../../src/core/client.ts";
import { conservativeCoalescing, noCoalescing } from "../../src/core/grouping.ts";
import type { CoalescingPolicy } from "../../src/core/grouping.ts";
import { AuthorityHost } from "../../src/core/host.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { RestrictedAuthority } from "../../src/core/visibility.ts";
import {
  makeRow,
  ROOT_ID,
  TEXT_TAG,
  textOf,
  toTable,
  createAllocator,
} from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { hiddenHandSchema } from "../fixtures/hidden-hand-schema.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { childrenDoc, listDoc, textDoc } from "../support/docs.ts";
import { FakeStore } from "../support/fake-store.ts";
import { tableFrom } from "../support/gen.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };
const SCHEMA_RICH = { id: "fixture.rich-text", version: "1.0.0" };

function rows(table: Table): string {
  return canonicalJson([...table.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
}

function roundTrip(changes: readonly Change[]): Change[] {
  return decodeChanges(JSON.parse(JSON.stringify(changes)));
}

describe("R35–R40 control, reversible records, checkpoints, and composition policy", () => {
  test("R35 Selected forward-control state machine", () => {
    const room = new Room(textDoc("0123"));
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    const c = room.join("c", "replica-c");
    // Several sequential unsent transactions while the first request is delayed; editing stays responsive.
    a.transact((w) => w.textInsert("t", 0, "A"));
    room.send("a");
    for (const [offset, ch] of [
      [3, "B"],
      [5, "C"],
    ] as const) {
      a.closeGroup();
      a.transact((w) => w.textInsert("t", offset, ch));
    }
    expect(textOf(a.getSnapshot().table.get("t"))).toBe("A01B2C3");
    expect(a.getStatus().unsent).toHaveLength(2); // distinct transactions stay unmerged
    b.transact((w) => w.textInsert("t", 2, "x"));
    c.transact((w) => w.textDelete("t", 3, 1));
    room.send("b");
    room.send("c");
    const commits: (readonly Change[])[] = [];
    a.subscribeCommits((commit) => commits.push(commit.mapping));
    room.deliver("a");
    expect(a.getStatus().integrations).toEqual({ forward: 2, recovery: 0 });
    // The visible state advanced by the mapped incoming changes only (no replay of the pending chain).
    expect(commits).toHaveLength(1);
    expect(commits[0]?.every((change) => change.origin.replica !== "replica-a")).toBe(true);
    expect(textOf(a.getSnapshot().table.get("t"))).toBe("A01Bx2C");
    // The own acknowledgement arrived in the same batch; each remaining pending form is expressed in
    // its own context: confirmed ("A01x2") plus its predecessors. B ties with x and wins by origin.
    expect(a.getStatus().confirmedRevision).toBe(3);
    expect(a.state.pending.map((e) => e.state)).toEqual(["unsent", "unsent"]);
    expect(a.state.pending[0]?.working[0]).toMatchObject({ offset: 3, text: "B" });
    expect(a.state.pending[1]?.working[0]).toMatchObject({ offset: 6, text: "C" });
    room.settle();
    for (const client of [a, b, c])
      expect(textOf(client.getSnapshot().table.get("t"))).toBe("A01Bx2C");
    // A second tab of the same actor is an independent replica stream.
    const tab = room.join("tab", "replica-a2", "a");
    tab.transact((w) => w.textInsert("t", 0, "T"));
    a.transact((w) => w.textInsert("t", 0, "U"));
    expect(tab.getStatus().unsent[0]?.replica).not.toBe(a.getStatus().unsent[0]?.replica);
    room.settle();
    expect(textOf(tab.getSnapshot().table.get("t"))).toBe(textOf(a.getSnapshot().table.get("t")));
  });

  test("R36 Transformed records retain exact reversible payloads", () => {
    const base = textDoc("abcd");
    const del = build(base, "replica-a", 1, (w) => w.textDelete("t", 1, 2));
    const ins = build(base, "replica-b", 1, (w) => w.textInsert("t", 2, "X"));
    const pair = transformPair(del, ins);
    if (isConflict(pair)) throw new Error("compatible");
    const abXcd = applyChanges(base, ins);
    const aXd = applyChanges(abXcd, roundTrip(pair.a));
    expect(textOf(aXd.get("t"))).toBe("aXd");
    expect(textOf(applyChanges(aXd, invertChanges(roundTrip(pair.a))).get("t"))).toBe("abXcd");

    // Overlap: the part another deletion already removed is not restored by this record's undo.
    const bc = build(base, "replica-a", 1, (w) => w.textDelete("t", 1, 2));
    const cd = build(base, "replica-b", 1, (w) => w.textDelete("t", 2, 2));
    const overlap = transformPair(bc, cd);
    if (isConflict(overlap)) throw new Error("compatible");
    expect(overlap.a).toEqual([expect.objectContaining({ offset: 1, text: "b" })]);
    const afterCd = applyChanges(base, cd);
    expect(
      textOf(
        applyChanges(applyChanges(afterCd, overlap.a), invertChanges(roundTrip(overlap.a))).get(
          "t",
        ),
      ),
    ).toBe("ab");
    // A fully redundant record transforms to no-op, whose inverse is also no-op.
    const same = transformPair(bc, bc);
    if (isConflict(same)) throw new Error("compatible");
    expect(same.a).toEqual([]);
    expect(invertChanges(same.a)).toEqual([]);

    // Property, array, move, and split/merge records transformed and inverted alone.
    const doc = tableFrom([
      makeRow(ROOT_ID, "doc", { items: ["a", "a"], x: 1 }, null, ["p", "q"], false),
      makeRow("p", "p", {}, ROOT_ID, ["r"], true),
      makeRow("r", TEXT_TAG, { value: "abcd" }, "p", [], false),
      makeRow("q", "p", {}, ROOT_ID, [], true),
    ]);
    const mine = build(doc, "replica-a", 1, (w) =>
      w.set(ROOT_ID, "x", 2).arrayDelete(ROOT_ID, ["items"], 1).moveNode("r", "q", 0),
    );
    const theirs = build(doc, "replica-b", 1, (w) => {
      w.arrayInsert(ROOT_ID, ["items"], 0, ["z"]);
      w.split("r", 2);
    });
    const crossed = transformPair(mine, theirs);
    expect(isConflict(crossed)).toBe(true); // moving a run that is concurrently split is a recorded conflict
    const textOnly = build(doc, "replica-b", 2, (w) => w.textInsert("r", 1, "!"));
    const moved = transformPair(mine, textOnly);
    if (isConflict(moved)) throw new Error("compatible");
    const branch = applyChanges(doc, textOnly);
    expect(
      rows(
        applyChanges(applyChanges(branch, roundTrip(moved.a)), invertChanges(roundTrip(moved.a))),
      ),
    ).toBe(rows(branch));

    // Tampered payloads in an original request are diagnosed, including after a context shift.
    const auth = Authority.create(DOC, EPOCH, doc);
    auth.submit(
      envelope(
        "replica-b",
        1,
        0,
        build(doc, "replica-b", 1, (w) => w.textInsert("r", 0, ">>")),
      ),
      { actor: "b" },
    );
    const forgedText = {
      ...(build(doc, "replica-a", 1, (w) => w.textDelete("r", 1, 2))[0] as Change),
      text: "zz",
    };
    const forgedValue = {
      ...(build(doc, "replica-a", 2, (w) => w.set(ROOT_ID, "x", 9))[0] as Change),
      before: 7,
    };
    const forgedSubtree = build(doc, "replica-a", 3, (w) => w.deleteNode("p"))[0] as Change & {
      subtree: { props: object };
    };
    const tamperedTree = {
      ...forgedSubtree,
      subtree: { ...forgedSubtree.subtree, props: { secret: "invented" } },
    };
    for (const [i, forged] of [forgedText, forgedValue, tamperedTree].entries()) {
      const decision = auth.submit(envelope("replica-a", 10 + i, 0, [forged as Change]), {
        actor: "a",
      });
      expect(decision.kind === "decided" && decision.receipt.outcome).toBe("rejected");
    }
    expect(auth.getRevision()).toBe(1);
  });

  test("R37 Immediate inversion and backward traversal from a checkpoint", () => {
    const parsed = parseDocument(
      `<doc><p id="p1">Alpha <emphasis>beta</emphasis> gamma</p><p id="p2">second</p></doc>`,
      richTextSchema,
    );
    if (!parsed.ok) throw new Error("fixture");
    const auth = Authority.create(DOC, EPOCH, toTable(parsed.value, createAllocator()));
    const oracle: string[] = [rows(auth.getTable())];
    const steps: ((w: ChangeBuilder, t: Table) => void)[] = [
      (w) => w.set("p2", "tags", ["x", "x", "y"]),
      (w) => w.arrayDelete("p2", ["tags"], 1),
      (w, t) => w.textReplace(t.get("p1")?.children[0] ?? "", 0, 5, "Omega"),
      (w) => w.moveNode("p2", ROOT_ID, 0),
      (w, t) => void w.split(t.get("p1")?.children[0] ?? "", 2),
      (w) => w.deleteNode("p1"),
    ];
    steps.forEach((step, i) => {
      const changes = build(auth.getTable(), "replica-a", i + 1, (w) => step(w, auth.getTable()));
      auth.submit(envelope("replica-a", i + 1, auth.getRevision(), changes), { actor: "a" });
      oracle.push(rows(auth.getTable()));
    });
    const bundle = JSON.parse(JSON.stringify(exportCheckpoint(auth, SCHEMA_RICH, 4))) as unknown;
    // Fresh state: only the checkpoint JSON (snapshot V plus four retained transitions) is available.
    const restored = restoreAuthority(bundle, [], SCHEMA_RICH);
    const retained = restored.transitionsSince(restored.getRevision() - 4) ?? [];
    expect(retained).toHaveLength(4);
    let cursor = restored.getTable();
    for (let i = retained.length - 1; i >= 0; i -= 1) {
      cursor = applyChanges(cursor, invertChanges(roundTrip(retained[i]?.changes ?? [])));
      expect(rows(cursor)).toBe(oracle[2 + i] as string);
    }
    for (const transition of retained) cursor = applyChanges(cursor, roundTrip(transition.changes));
    expect(rows(cursor)).toBe(oracle[6] as string);
    // Beyond the retained horizon, traversal is explicitly unavailable; a bare snapshot advertises none.
    expect(restored.transitionsSince(restored.getRevision() - 5)).toBeUndefined();
    const bare = restoreAuthority(
      JSON.parse(JSON.stringify(exportCheckpoint(auth, SCHEMA_RICH, 0))),
      [],
      SCHEMA_RICH,
    );
    expect(bare.transitionsSince(bare.getRevision() - 1)).toBeUndefined();
  });

  test("R38 Retained undo/redo survives checkpoint truncation and restart", () => {
    const room = new Room(listDoc({ title: "t", x: 0, note: "n" }));
    const own = room.join("own", "replica-o", "alice", { undoLimit: 3 });
    const other = room.join("other", "replica-r", "bob");
    const old = own.transact((w) => w.set(ROOT_ID, "title", "mine"));
    own.closeGroup();
    room.settle();
    own.transact((w) => w.set(ROOT_ID, "x", 1));
    room.settle();
    other.transact((w) => w.set(ROOT_ID, "note", "remote"));
    room.settle();
    own.undo(); // undoes x → redo exists
    room.settle();
    if (old.status !== "applied") throw new Error("setup");
    const store = new FakeStore();
    const host = AuthorityHost.open(
      store,
      SCHEMA,
      () => new Authority(room.authority.exportState()),
    );
    host.checkpoint(0); // V: prefix transforms deleted
    const session = own.exportSession();
    expect(store.read().checkpoint?.transitions).toEqual([]);

    // Restart: only checkpoint + tail + the locally saved session.
    const restarted = AuthorityHost.open(store, SCHEMA, () => {
      throw new Error("no genesis replay");
    });
    const revived = new Client({
      documentId: DOC,
      historyEpoch: EPOCH,
      allocator: SequenceAllocator.ephemeral("replica-o2"),
      actor: "alice",
      table: restarted.authority.getTable(),
      revision: restarted.authority.getRevision(),
      restore: session,
      undoLimit: 3,
    });
    const bob = new Client({
      documentId: DOC,
      historyEpoch: EPOCH,
      allocator: SequenceAllocator.ephemeral("replica-r2"),
      actor: "bob",
      table: restarted.authority.getTable(),
      revision: restarted.authority.getRevision(),
    });
    const sendFrom = (client: Client, actor: string) => {
      const request = client.nextRequest();
      if (request === undefined) return;
      const decision = restarted.submit(request, { actor });
      if (decision.kind !== "decided") throw new Error("resync");
      const events =
        decision.transition === undefined
          ? [decision.receipt]
          : [decision.transition, decision.receipt];
      client.receive(events);
      for (const peer of [revived, bob])
        if (peer !== client && decision.transition !== undefined) peer.receive(decision.transition);
    };
    bob.transact((w) => w.set(ROOT_ID, "note", "after restart"));
    sendFrom(bob, "bob");
    expect(revived.redo().status).toBe("requested");
    sendFrom(revived, "alice");
    expect(restarted.authority.getTable().get(ROOT_ID)?.props).toEqual({
      title: "mine",
      x: 1,
      note: "after restart",
    });
    expect(revived.undo(old.group).status).toBe("requested");
    sendFrom(revived, "alice");
    expect(restarted.authority.getTable().get(ROOT_ID)?.props["title"]).toBe("t");
    // A superseding absolute write still conflicts after the original log entries are gone.
    bob.transact((w) => w.set(ROOT_ID, "x", 5));
    sendFrom(bob, "bob");
    expect(revived.undo().status).toBe("conflict");
    // An expired group reports unavailable instead of fetching a deleted prefix.
    for (let i = 0; i < 4; i += 1) {
      revived.closeGroup();
      revived.transact((w) => w.set(ROOT_ID, "note", `n${i}`));
      sendFrom(revived, "alice");
    }
    expect(revived.undo(old.group).status).toBe("unavailable");
  });

  test("R39 Checkpoint cut, failure, and deduplication", () => {
    for (const interrupt of ["stage", "publish", "prune"] as const) {
      const store = new FakeStore();
      const host = AuthorityHost.open(store, SCHEMA, () =>
        Authority.create(DOC, EPOCH, listDoc({ items: ["a", "b"], count: 1 })),
      );
      const base = host.authority.getTable();
      const delta = envelope(
        "replica-a",
        1,
        0,
        build(base, "replica-a", 1, (w) => w.delta(ROOT_ID, "count", 5)),
      );
      host.submit(delta, { actor: "a" });
      store.interrupt = interrupt;
      expect(() => host.checkpoint(0)).toThrow();
      store.interrupt = undefined;
      const boundary = envelope(
        "replica-b",
        1,
        1,
        build(host.authority.getTable(), "replica-b", 1, (w) =>
          w.arrayDelete(ROOT_ID, ["items"], 0),
        ),
      );
      host.submit(boundary, { actor: "b" });
      host.checkpoint(0);
      const restored = AuthorityHost.open(store, SCHEMA, () => {
        throw new Error("no genesis");
      });
      expect(restored.authority.getTable().get(ROOT_ID)?.props).toEqual({ items: ["b"], count: 6 });
      expect(restored.authority.getRevision()).toBe(2);
      for (const retry of [delta, boundary]) {
        const again = restored.submit(retry, { actor: retry.replica === "replica-a" ? "a" : "b" });
        expect(again.kind === "decided" && again.duplicate).toBe(true);
      }
      expect(restored.authority.getTable().get(ROOT_ID)?.props).toEqual({ items: ["b"], count: 6 });
    }
    // A local in-flight request persisted separately keeps its original bytes across restart.
    const room = new Room(listDoc({ items: ["a"], count: 1 }));
    const client = room.join("c", "replica-c");
    client.transact((w) => w.delta(ROOT_ID, "count", 1));
    const bytes = canonicalJson(client.nextRequest());
    const saved = JSON.parse(JSON.stringify(client.exportSession())) as ReturnType<
      Client["exportSession"]
    >;
    const revived = new Client({
      documentId: DOC,
      historyEpoch: EPOCH,
      allocator: SequenceAllocator.ephemeral("replica-c", 1),
      actor: "c",
      table: room.authority.getTable(),
      revision: 0,
      restore: saved,
    });
    expect(canonicalJson(revived.resend())).toBe(bytes);
    // An actual history reset (new epoch) does not reinterpret old requests.
    const reset = Authority.create(DOC, "epoch-2", room.authority.getTable());
    expect(() => reset.submit(revived.resend(), { actor: "c" })).toThrow();
    // Participant exports never carry another region's content, even content deleted earlier.
    const game = parseDocument(
      `<game><table id="table1" /><hand id="hA" owner="alice"><card id="cA" rank="Q" suit="spades" /></hand><hand id="hB" owner="bob"><card id="cB" rank="7" suit="hearts" /><card id="cB2" rank="2" suit="clubs" /></hand></game>`,
      hiddenHandSchema,
    );
    if (!game.ok) throw new Error("fixture");
    const restricted = new RestrictedAuthority(
      hiddenHandSchema,
      DOC,
      EPOCH,
      toTable(game.value, createAllocator()),
    );
    restricted.submit(
      envelope(
        "replica-bob",
        1,
        0,
        build(restricted.fullView(), "replica-bob", 1, (w) => w.deleteNode("cB2")),
      ),
      { actor: "bob" },
    );
    const exported = JSON.stringify(restricted.exportFor("alice"));
    expect(exported).not.toContain("clubs");
    expect(exported).not.toContain("hearts");
    expect(exported).toContain("spades");
  });

  test("R40 Composition policy differs by application, not OT rules", () => {
    const run = (policy: CoalescingPolicy, explicit: boolean) => {
      const room = new Room(listDoc({ x: 0, samples: [] }));
      const client = room.join("c", "replica-c", "c", { coalescing: policy });
      if (explicit) client.beginGroup("gesture");
      for (let i = 1; i <= 5; i += 1) {
        client.transact((w) => w.set(ROOT_ID, "x", i));
        client.transact((w) => w.arrayInsert(ROOT_ID, ["samples"], i - 1, [i]));
      }
      if (explicit) client.endGroup();
      return { room, client };
    };
    const typing = run(conservativeCoalescing, false);
    expect(typing.client.getStatus().unsent.length).toBeGreaterThan(1);
    const drag = run(
      {
        allow: (ctx) => ctx.sameGroup && ctx.current.kind === "set" && ctx.previous.kind === "set",
      },
      true,
    );
    const trajectory = run(noCoalescing, true);
    expect(trajectory.client.getStatus().unsent).toHaveLength(10);
    for (const { room, client } of [typing, drag, trajectory]) {
      room.settle();
      expect(room.authority.getTable().get(ROOT_ID)?.props).toEqual({
        x: 5,
        samples: [1, 2, 3, 4, 5],
      });
      expect(client.undo().status).toBe("requested");
      room.settle();
    }
    // One explicit group undoes all accepted drag/trajectory updates, each individually accounted for.
    expect(trajectory.room.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 0, samples: [] });
    expect(trajectory.room.authority.getRevision()).toBe(11);
    expect(drag.room.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 0, samples: [] });
    // "allow everything" cannot merge another replica's work, a sent request, or an unsupported pair.
    const room = new Room(childrenDoc(["A"]));
    const permissive = room.join("p", "replica-p", "p", { coalescing: { allow: () => true } });
    const peer = room.join("q", "replica-q");
    permissive.transact((w) => w.set("A", "label", "1"));
    room.send("p"); // now in flight: never a coalescing target
    permissive.transact((w) => w.set("A", "label", "2"));
    permissive.transact((w) => void w.insertNode(ROOT_ID, 0, { tag: "item", id: "B", props: {} }));
    peer.transact((w) => w.set("A", "label", "peer"));
    expect(permissive.getStatus().unsent).toHaveLength(2);
    expect(permissive.state.pending[0]?.working).toEqual([expect.objectContaining({ after: "1" })]);
    expect(
      permissive.state.pending
        .flatMap((e) => e.working)
        .every((c) => c.origin.replica === "replica-p"),
    ).toBe(true);
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["B", "A"]);
    expect(room.authority.getTable().get("A")?.props["label"]).toBe("2");
  });
});
