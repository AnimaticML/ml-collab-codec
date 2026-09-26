import { describe, expect, test } from "bun:test";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { exportCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { SnapshotError } from "../../src/core/snapshot-rows.ts";
import type { Change } from "../../src/core/change.ts";
import type { Client } from "../../src/core/client.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { AuthorityHost, StaleOwnerError } from "../../src/core/host.ts";
import { recordOf } from "../../src/core/authority.ts";
import { mapAnchor } from "../../src/core/anchors.ts";
import type { Anchor } from "../../src/core/anchors.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import { items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { FakeStore } from "../support/fake-store.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };

function outcome(decision: Decision): string {
  return decision.kind === "decided" ? decision.receipt.outcome : decision.kind;
}

describe("R50–R54 revisions, deduplication, hosting, profile, and presence", () => {
  test("R50 Revision, receipt, and history scopes are distinct", () => {
    const base = textDoc("abc");
    const auth = Authority.create(DOC, EPOCH, base);
    const many = build(base, "replica-a", 1, (w) => {
      for (let i = 0; i < 20; i += 1) w.textInsert("t", 0, `${i % 10}`);
    });
    auth.submit(envelope("replica-a", 1, 0, many), { actor: "a" });
    expect(auth.getRevision()).toBe(1);
    const noop1 = auth.submit(envelope("replica-a", 5, 1, []), { actor: "a" }); // sequence gap 2..4
    const forged: Change = {
      kind: "textDelete",
      node: "t",
      offset: 0,
      text: "zz",
      origin: { replica: "replica-b", seq: 1, ordinal: 0 },
    };
    const noop2 = auth.submit(envelope("replica-b", 1, 1, [forged]), { actor: "b" }); // rejected: precondition
    for (const d of [noop1, noop2])
      expect(d.kind === "decided" && d.receipt.evaluatedRevision).toBe(1);
    expect(auth.getRevision()).toBe(1);
    // A content-equal transition still advances and keeps its mapping (delete + reinsert of equal text).
    const room = new Room(textDoc("abc"));
    const writer = room.join("w", "replica-w");
    const reader = room.join("r", "replica-r");
    const commits: number[] = [];
    const mappings: number[] = [];
    reader.subscribeCommits(() => commits.push(1));
    reader.subscribeStatus((s) => mappings.push(s.mapping.length));
    writer.transact((w) => w.textDelete("t", 1, 1).textInsert("t", 1, "b"));
    expect(writer.getStatus().confirmedRevision).toBe(0); // local optimistic edits mint no server revision
    room.settle();
    expect(room.authority.getRevision()).toBe(1);
    expect(commits).toHaveLength(0);
    expect(mappings.some((n) => n > 0)).toBe(true);
    // A missing transition is buffered; later ones wait; repeats are ignored.
    const late = new Room(textDoc("ab"));
    const producer = late.join("p", "replica-p");
    const consumer = late.join("c", "replica-c");
    producer.transact((w) => w.textInsert("t", 0, "1"));
    late.send("p");
    late.deliver("p");
    producer.transact((w) => w.textInsert("t", 0, "2"));
    late.send("p");
    const [t1, t2] = late.member("c").inbox.splice(0);
    if (t1 === undefined || t2 === undefined) throw new Error("setup");
    consumer.receive(t2);
    expect(consumer.getStatus().confirmedRevision).toBe(0);
    consumer.receive([t1, t1, t2]);
    expect(textOf(consumer.getSnapshot().table.get("t"))).toBe("21ab");
    // Wrong document, reset epoch, or a claimed replica of another actor fail before mutation.
    expect(() => consumer.receive({ ...t1, historyEpoch: "epoch-2" })).toThrow(ProtocolError);
    expect(() => consumer.receive({ ...t1, documentId: "other" })).toThrow(ProtocolError);
    expect(() =>
      late.authority.submit(
        { ...envelope("replica-x", 1, 0, []), documentId: "other" },
        { actor: "x" },
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      late.authority.submit(envelope("replica-p", 99, 2, []), { actor: "mallory" }),
    ).toThrow(ProtocolError);
    expect(textOf(late.authority.getTable().get("t"))).toBe("21ab");
  });

  test("R51 Deduplication survives rejection, holes, pruning, and restart", () => {
    const base = listDoc({ items: ["a", "b"], count: 1 });
    const auth = Authority.create(DOC, EPOCH, base, { validators: [schemaValidator(listSchema)] });
    const delta = envelope(
      "replica-a",
      1,
      0,
      build(base, "replica-a", 1, (w) => w.delta(ROOT_ID, "count", 5)),
    );
    const removeA = envelope(
      "replica-a",
      2,
      0,
      build(base, "replica-a", 2, (w) => w.arrayDelete(ROOT_ID, ["items"], 0)),
    );
    const removeAgain = envelope(
      "replica-b",
      1,
      0,
      build(base, "replica-b", 1, (w) => w.arrayDelete(ROOT_ID, ["items"], 0)),
    );
    const removeB = envelope(
      "replica-c",
      1,
      0,
      build(base, "replica-c", 1, (w) => w.arrayDelete(ROOT_ID, ["items"], 1)),
    );
    const first = [delta, removeA, removeAgain, removeB].map((e) =>
      auth.submit(e, { actor: e.replica }),
    );
    expect(first.map(outcome)).toEqual(["applied", "applied", "alreadySatisfied", "rejected"]);
    // Relax the situation: the rejected request still answers rejected; a new attempt needs a new id.
    auth.submit(
      envelope(
        "replica-z",
        1,
        2,
        build(auth.getTable(), "replica-z", 1, (w) => w.arrayInsert(ROOT_ID, ["items"], 0, ["n"])),
      ),
      { actor: "z" },
    );
    const check = (a: Authority) => {
      const again = [delta, removeA, removeAgain, removeB].map((e) =>
        a.submit(e, { actor: e.replica }),
      );
      expect(again.map(outcome)).toEqual(["applied", "applied", "alreadySatisfied", "rejected"]);
      expect(again.every((d) => d.kind === "decided" && d.duplicate)).toBe(true);
      expect(a.getTable().get(ROOT_ID)?.props["count"]).toBe(6);
      expect(items(a.getTable())).toEqual(["n", "b"]);
    };
    check(auth);
    check(
      restoreAuthority(exportCheckpoint(auth, SCHEMA), [], SCHEMA, {
        validators: [schemaValidator(listSchema)],
      }),
    );
    expect(() => auth.submit({ ...removeB, changes: [] }, { actor: "replica-c" })).toThrow(
      ProtocolError,
    );
    // Holes below the highest seen sequence are not new work; expiry answers resync, never re-execution.
    const hole = auth.submit(envelope("replica-a", 1_000, auth.getRevision(), []), {
      actor: "replica-a",
    });
    expect(outcome(hole)).toBe("alreadySatisfied");
    expect(
      auth.submit(envelope("replica-a", 3, auth.getRevision(), []), { actor: "replica-a" }).kind,
    ).toBe("resync");
    auth.expireReceiptsThrough(auth.getRevision());
    const expired = auth.submit(delta, { actor: "replica-a" });
    expect(expired.kind).toBe("resync");
    expect(auth.getTable().get(ROOT_ID)?.props["count"]).toBe(6);
    expect(JSON.stringify(first.map((d) => (d.kind === "decided" ? d.receipt : d)))).not.toContain(
      '"a"',
    );
  });

  test("R52 One logical authority has a host-independent atomic contract", () => {
    const store = new FakeStore();
    const genesis = () => Authority.create(DOC, EPOCH, textDoc("ab"));
    const host = AuthorityHost.open(store, SCHEMA, genesis);
    const base = textDoc("ab");
    // A racing handler with the same ownership commits first at revision 0.
    const racer = AuthorityHost.open(store, SCHEMA, genesis);
    racer.submit(
      envelope(
        "replica-r",
        1,
        0,
        build(base, "replica-r", 1, (w) => w.textInsert("t", 1, "R")),
      ),
      { actor: "r" },
    );
    // The stale host is fenced; after reopening it reevaluates against the new context.
    expect(() =>
      host.submit(
        envelope(
          "replica-h",
          1,
          0,
          build(base, "replica-h", 1, (w) => w.textInsert("t", 1, "H")),
        ),
        { actor: "h" },
      ),
    ).toThrow(StaleOwnerError);
    const reopened = AuthorityHost.open(store, SCHEMA, genesis);
    const decided = reopened.submit(
      envelope(
        "replica-h",
        1,
        0,
        build(base, "replica-h", 1, (w) => w.textInsert("t", 1, "H")),
      ),
      { actor: "h" },
    );
    expect(decided.kind === "decided" && decided.transition?.revision).toBe(2);
    expect(textOf(reopened.authority.getTable().get("t"))).toBe("aHRb");
    // Compare-and-commit loss: a second handler of the same owner commits at our position first;
    // the host reloads checkpoint + tail and re-evaluates instead of appending its stale candidate.
    const peer = AuthorityHost.open(store, SCHEMA, genesis);
    const sibling = restoreAuthority(store.read().checkpoint, store.read().records, SCHEMA);
    const siblingPrepared = sibling.prepare(
      envelope(
        "replica-s",
        1,
        2,
        build(sibling.getTable(), "replica-s", 1, (w) => w.textInsert("t", 0, "S")),
      ),
      { actor: "s" },
    );
    const siblingRecord = recordOf(siblingPrepared);
    if (siblingRecord === undefined) throw new Error("setup");
    expect(store.append(store.read().position, store.currentOwner(), siblingRecord)).toBe(
      "committed",
    );
    const q = peer.submit(
      envelope(
        "replica-q",
        1,
        2,
        build(peer.authority.getTable(), "replica-q", 1, (w) => w.textInsert("t", 0, "Q")),
      ),
      { actor: "q" },
    );
    expect(q.kind === "decided" && q.transition?.revision).toBe(4);
    expect(store.append(0, store.currentOwner() - 1, siblingRecord)).toBe("fenced");
    // Checkpoint and restore on a fresh host with no process globals; retry an old request, then new work.
    peer.checkpoint(1);
    const fresh = AuthorityHost.open(store, SCHEMA, () => {
      throw new Error("genesis must not be needed");
    });
    const retry = fresh.submit(
      envelope(
        "replica-r",
        1,
        0,
        build(base, "replica-r", 1, (w) => w.textInsert("t", 1, "R")),
      ),
      { actor: "r" },
    );
    expect(retry.kind === "decided" && retry.duplicate).toBe(true);
    fresh.submit(
      envelope(
        "replica-n",
        1,
        fresh.authority.getRevision(),
        build(fresh.authority.getTable(), "replica-n", 1, (w) => w.textInsert("t", 0, "N")),
      ),
      { actor: "n" },
    );
    expect(textOf(fresh.authority.getTable().get("t"))).toBe("NQSaHRb");
    expect(fresh.authority.scope()).toEqual({ documentId: DOC, historyEpoch: EPOCH });
    // A separate document progresses independently.
    const other = AuthorityHost.open(new FakeStore(), SCHEMA, () =>
      Authority.create("doc-2", EPOCH, textDoc("zz")),
    );
    expect(other.authority.getRevision()).toBe(0);
  });

  test("R53 The selected scalar profile is explicit and fail-closed", () => {
    const room = new Room(textDoc("ab"));
    const client = room.join("a", "replica-a");
    client.transact((w) => w.textInsert("t", 1, "x"));
    const request = client.nextRequest();
    const session = client.exportSession();
    room.submit("a", request);
    expect(Object.keys(request ?? {}).sort()).toEqual([
      "baseRevision",
      "changes",
      "documentId",
      "historyEpoch",
      "meta",
      "opFormat",
      "profile",
      "replica",
      "seq",
    ]);
    expect(session.pending[0]?.submitted?.profile).toBe("sdl.scalar-prefix/1");
    const revision = room.authority.getRevision();
    for (const bad of [
      { ...request, profile: "sdl.scalar-prefix/2" },
      { ...request, vector: { "replica-a": 3 } },
      { ...request, meta: { vectorClock: {} } },
      { type: "presence", cursor: 3 },
    ]) {
      expect(() => room.authority.submit(bad, { actor: "a" })).toThrow(ProtocolError);
    }
    expect(room.authority.getRevision()).toBe(revision);
    expect(client.getStatus().inFlight).toEqual({ replica: "replica-a", seq: 1 });
    const checkpoint = exportCheckpoint(room.authority, SCHEMA);
    expect(() => restoreAuthority({ ...checkpoint, profile: "sdl.vector/1" }, [], SCHEMA)).toThrow(
      SnapshotError,
    );
    expect(() =>
      restoreAuthority(checkpoint, [], { id: "fixture.list", version: "2.0.0" }),
    ).toThrow(SnapshotError);
    room.settle();
    expect(textOf(room.authority.getTable().get("t"))).toBe("axb");
  });

  test("R54 Ephemeral presence and local timing do not mutate document history", () => {
    const room = new Room(textDoc("hello"));
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    const presence: { cursor: Anchor; base: number }[] = [];
    let commits = 0;
    b.subscribeCommits((commit) => {
      commits += 1;
      for (const entry of presence) {
        const result = mapAnchor(entry.cursor, commit.mapping);
        if (result.status === "mapped") entry.cursor = result.anchor;
      }
    });
    const lastSeq = (client: Client) => client.options.allocator.last;
    for (let i = 0; i < 50; i += 1)
      presence.push({
        cursor: { kind: "point", node: "t", offset: i % 5, affinity: "after" },
        base: 0,
      });
    expect(lastSeq(a)).toBe(0);
    expect(room.authority.getRevision()).toBe(0);
    expect(a.history.list()).toHaveLength(0);
    expect(commits).toBe(0);
    a.transact((w) => w.textInsert("t", 0, ">"));
    room.settle();
    expect(commits).toBe(1);
    expect(presence[4]?.cursor).toMatchObject({ offset: 5 });
    // A presence envelope misrouted into the durable decoder is refused before mutation.
    expect(() =>
      room.authority.submit(
        { type: "presence", replica: "replica-a", cursor: presence[0]?.cursor },
        { actor: "a" },
      ),
    ).toThrow(ProtocolError);
    expect(room.authority.getRevision()).toBe(1);
    expect(textOf(b.getSnapshot().table.get("t"))).toBe(">hello");
  });
});
