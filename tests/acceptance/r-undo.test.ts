import { describe, expect, test } from "bun:test";
import { schemaValidator } from "../../src/core/invariants.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import { childrenDoc, items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { envelope } from "../support/requests.ts";
import { Room } from "../support/room.ts";

function text(room: Room, name?: string): string {
  const table =
    name === undefined ? room.authority.getTable() : room.client(name).getSnapshot().table;
  return textOf(table.get("t"));
}

function converged(room: Room): string {
  const truth = text(room);
  for (const name of room.members.keys()) expect(text(room, name)).toBe(truth);
  return truth;
}

describe("R16–R22 collaborative undo/redo and pending intent", () => {
  test("R16 Undo a group while preserving remote contributions", () => {
    const room = new Room(textDoc("ab"));
    const own = room.join("own", "replica-o");
    const remote = room.join("remote", "replica-r");
    own.transact((b) => b.textInsert("t", 1, "X"));
    room.settle();
    remote.transact((b) => b.textInsert("t", 3, "Y"));
    room.settle();
    expect(converged(room)).toBe("aXbY");
    expect(own.undo().status).toBe("requested");
    room.settle();
    expect(converged(room)).toBe("abY");

    // Remote text inserted inside the own insertion survives cancellation of only the own characters.
    const nested = new Room(textDoc("ab"));
    const author = nested.join("own", "replica-o");
    const other = nested.join("remote", "replica-r");
    author.transact((b) => b.textInsert("t", 1, "XY"));
    nested.settle();
    other.transact((b) => b.textInsert("t", 2, "!"));
    nested.settle();
    expect(converged(nested)).toBe("aX!Yb");
    author.undo();
    nested.settle();
    expect(converged(nested)).toBe("a!b");

    // Own typing across several accepted transactions in one group, with unrelated remote field changes.
    const typing = new Room(listDoc({ title: "t" }));
    const typist = typing.join("own", "replica-o");
    const editor = typing.join("remote", "replica-r");
    typist.transact((b) => void b.insertNode(ROOT_ID, 0, "ab"));
    typing.settle();
    const run = typing.authority.getTable().get(ROOT_ID)?.children[0] ?? "";
    typist.beginGroup("typing");
    for (const [i, ch] of ["x", "y", "z"].entries()) {
      typist.transact((b) => b.textInsert(run, 1 + i, ch));
      typing.settle();
    }
    typist.endGroup();
    editor.transact((b) => b.set(ROOT_ID, "title", "remote"));
    typing.settle();
    expect(typist.undo().status).toBe("requested");
    typing.settle();
    expect(textOf(typing.authority.getTable().get(run))).toBe("ab");
    expect(typing.authority.getTable().get(ROOT_ID)?.props["title"]).toBe("remote");
  });

  test("R17 Target an older own group without erasing later work", () => {
    const room = new Room(listDoc({ x: 0, title: "t", note: "n" }));
    const own = room.join("own", "replica-o", "alice");
    const other = room.join("other", "replica-r", "bob");
    const g1 = own.transact((b) => b.set(ROOT_ID, "x", 1));
    room.settle();
    own.transact((b) => b.set(ROOT_ID, "title", "later"));
    room.settle();
    other.transact((b) => b.set(ROOT_ID, "note", "remote"));
    room.settle();
    if (g1.status !== "applied") throw new Error("setup");
    expect(own.undo(g1.group).status).toBe("requested");
    room.settle();
    const props = room.authority.getTable().get(ROOT_ID)?.props;
    expect(props).toEqual({ x: 0, title: "later", note: "remote" });
    expect(own.history.get(g1.group)?.state).toBe("undone");
    expect(own.history.latestUndoable()?.id).not.toBe(g1.group);

    // A group id alone does not authorize another actor.
    const forged = room.submit(
      "other",
      envelope("replica-r", 99, room.authority.getRevision(), [], { undoOf: g1.group }),
    );
    expect(forged.kind === "decided" && forged.receipt.outcome).toBe("rejected");
    expect(forged.kind === "decided" && forged.receipt.reason).toBe("not authorized");

    // Mixed group: one contribution already removed by someone else is accounted for explicitly.
    const mixed = new Room(textDoc("ab"));
    const author = mixed.join("own", "replica-o");
    const remover = mixed.join("remote", "replica-r");
    author.transact((b) => b.textInsert("t", 1, "XY"));
    mixed.settle();
    remover.transact((b) => b.textDelete("t", 2, 1));
    mixed.settle();
    const result = author.undo();
    expect(result).toMatchObject({ status: "requested" });
    mixed.settle();
    expect(converged(mixed)).toBe("ab");
  });

  test("R18 Conflicting cancellation is explicit and atomic", () => {
    const room = new Room(listDoc({ x: 0 }));
    const own = room.join("own", "replica-o");
    const other = room.join("other", "replica-r");
    own.transact((b) => b.set(ROOT_ID, "x", 1));
    room.settle();
    other.transact((b) => b.set(ROOT_ID, "x", 2));
    room.settle();
    const first = own.undo();
    expect(first.status).toBe("conflict");
    expect(room.authority.getTable().get(ROOT_ID)?.props["x"]).toBe(2);
    // Writing the old value back does not re-establish ownership of the original effect.
    other.transact((b) => b.set(ROOT_ID, "x", 1));
    room.settle();
    expect(own.undo().status).toBe("conflict");
    expect(room.authority.getTable().get(ROOT_ID)?.props["x"]).toBe(1);
    expect(JSON.stringify(first)).not.toContain("2");

    // Undo of a creation must not delete later remote work inside it; the whole group is refused.
    const nodes = new Room(childrenDoc(["A"]));
    const creator = nodes.join("own", "replica-o");
    const editor = nodes.join("remote", "replica-r");
    creator.beginGroup("create");
    creator.transact(
      (b) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "N", props: { label: "new" } }),
    );
    creator.transact((b) => b.set("A", "label", "renamed"));
    creator.endGroup();
    nodes.settle();
    editor.transact((b) => b.set("N", "label", "remote edit"));
    nodes.settle();
    const refused = creator.undo();
    expect(refused.status).toBe("conflict");
    const table = nodes.authority.getTable();
    expect(table.get("N")?.props["label"]).toBe("remote edit");
    expect(table.get("A")?.props["label"]).toBe("renamed");
    expect(creator.history.latestUndoable()?.id).toBe(
      refused.status === "conflict" ? refused.group : "",
    );
  });

  test("R19 Redo follows the actual undo", () => {
    const room = new Room(textDoc("ab"));
    const own = room.join("own", "replica-o");
    const other = room.join("other", "replica-r");
    own.transact((b) => b.textInsert("t", 1, "XY"));
    room.settle();
    other.transact((b) => b.textDelete("t", 2, 1)); // removes Y: partially no longer effective
    room.settle();
    own.undo();
    room.settle();
    expect(converged(room)).toBe("ab");
    other.transact((b) => b.textInsert("t", 2, "!"));
    room.settle();
    expect(own.redo().status).toBe("requested");
    room.settle();
    // Only what the undo actually removed (X) comes back; intervening remote work stays.
    expect(converged(room)).toBe("aXb!");
    let prefix = "";
    for (let cycle = 0; cycle < 3; cycle += 1) {
      own.undo();
      room.settle();
      expect(converged(room)).toBe(`${prefix}ab!`);
      prefix = `${cycle}${prefix}`;
      other.transact((b) => b.textInsert("t", 0, `${cycle}`));
      room.settle();
      own.redo();
      room.settle();
      expect(converged(room)).toBe(`${prefix}aXb!`);
    }
    // Fresh local work clears the redo branch; accepted history stays intact.
    own.undo();
    room.settle();
    const revision = room.authority.getRevision();
    own.transact((b) => b.textInsert("t", 0, "~"));
    expect(own.redo().status).toBe("unavailable");
    room.settle();
    expect(room.authority.transitionsSince(revision - 1)).toHaveLength(2);
  });

  test("R20 Undo respects current constraints and authorization", () => {
    const room = new Room(listDoc({ items: ["b"] }), {
      validators: [schemaValidator(listSchema)],
    });
    const own = room.join("own", "replica-o");
    const other = room.join("other", "replica-r");
    own.transact((b) => b.arrayInsert(ROOT_ID, ["items"], 0, ["a"]));
    room.settle();
    other.transact((b) => b.arrayDelete(ROOT_ID, ["items"], 1));
    room.settle();
    expect(items(room.authority.getTable())).toEqual(["a"]);
    const group = own.undo();
    room.settle();
    const receipt = room.decisions.at(-1);
    expect(receipt?.kind === "decided" && receipt.receipt.outcome).toBe("rejected");
    expect(items(room.authority.getTable())).toEqual(["a"]);
    expect(own.history.latestUndoable()?.id).toBe(group.group);
    expect(own.history.get(group.group ?? "")?.lastError).toContain("too few items");

    // Rights revoked between the action and its undo: checked at commit, nothing half-applied.
    const allowed = new Set(["alice"]);
    const rights = new Room(listDoc({ x: 0, title: "t" }), {
      authorize: (actor) => allowed.has(actor),
    });
    const alice = rights.join("alice", "replica-a", "alice");
    alice.beginGroup("edit");
    alice.transact((b) => b.set(ROOT_ID, "x", 1));
    alice.transact((b) => b.set(ROOT_ID, "title", "u"));
    alice.endGroup();
    rights.settle();
    allowed.delete("alice");
    const undo = alice.undo();
    rights.settle();
    expect(rights.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 1, title: "u" });
    expect(alice.history.latestUndoable()?.id).toBe(undo.group);
    allowed.add("alice");
    expect(alice.undo().status).toBe("requested");
    rights.settle();
    expect(rights.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 0, title: "t" });
    allowed.delete("alice");
    alice.redo();
    rights.settle();
    expect(rights.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 0, title: "t" });
  });

  test("R21 Unsent and in-flight undo are not the same", () => {
    const room = new Room(childrenDoc(["A"]));
    const own = room.join("own", "replica-o");
    const create = own.transact(
      (b) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "N", props: { label: "n" } }),
    );
    own.closeGroup();
    own.transact((b) => b.set("N", "label", "dependent"));
    own.closeGroup();
    own.transact((b) => b.set("A", "label", "independent"));
    expect(own.undo(create.status === "applied" ? create.group : "").status).toBe(
      "cancelledLocally",
    );
    const status = own.getStatus();
    expect(status.unsent).toHaveLength(1);
    expect(status.retained.map((r) => r.status)).toEqual(["blocked"]);
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["A"]);
    expect(room.authority.getTable().get("A")?.props["label"]).toBe("independent");

    // In flight: undo waits for the original outcome, then sends a properly based compensation.
    const flight = new Room(textDoc("ab"));
    const author = flight.join("own", "replica-o");
    flight.join("peer", "replica-p");
    author.transact((b) => b.textInsert("t", 1, "X"));
    flight.send("own");
    expect(author.undo().status).toBe("deferred");
    const receiptEvents = [...flight.member("own").inbox];
    flight.deliver("own");
    author.receive(receiptEvents); // duplicate delayed delivery
    flight.settle();
    expect(converged(flight)).toBe("ab");
    expect(flight.authority.getRevision()).toBe(2);

    // The original is rejected while the undo waits: nothing to compensate, and no ghost effect.
    const rejected = new Room(listDoc({ x: 0 }));
    const first = rejected.join("first", "replica-f");
    const second = rejected.join("second", "replica-s");
    first.transact((b) => b.set(ROOT_ID, "x", 1));
    second.transact((b) => b.set(ROOT_ID, "x", 2));
    rejected.send("first");
    rejected.send("second");
    expect(second.undo().status).toBe("deferred");
    rejected.settle();
    expect(rejected.authority.getTable().get(ROOT_ID)?.props["x"]).toBe(1);
    expect(second.getSnapshot().table.get(ROOT_ID)?.props["x"]).toBe(1);
    expect(second.getStatus().retained.map((r) => r.status)).toEqual(["rejected"]);
    expect(rejected.authority.getRevision()).toBe(1);
  });

  test("R22 New undo commands versus duplicate delivery", () => {
    const room = new Room(listDoc({ count: 10 }));
    const own = room.join("own", "replica-o");
    own.transact((b) => b.delta(ROOT_ID, "count", 5));
    const original = own.nextRequest();
    room.submit("own", original);
    room.settle();
    own.undo();
    const undo = own.nextRequest();
    room.submit("own", undo);
    room.settle();
    own.redo();
    const redo = own.nextRequest();
    room.submit("own", redo);
    room.settle();
    expect([original?.seq, undo?.seq, redo?.seq]).toEqual([1, 2, 3]);
    expect(undo?.meta.undoOf).toBe(original?.meta.group);
    expect(redo?.meta.redoOf).toBe(original?.meta.group);
    const revision = room.authority.getRevision();
    for (const request of [original, undo, redo]) {
      const retry = room.submit("own", request);
      expect(retry.kind === "decided" && retry.duplicate).toBe(true);
    }
    room.settle();
    expect(room.authority.getRevision()).toBe(revision);
    expect(room.authority.getTable().get(ROOT_ID)?.props["count"]).toBe(15);
    expect(room.authority.transitionsSince(0)?.map((t) => t.request.seq)).toEqual([1, 2, 3]);
    expect(() => room.submit("own", { ...redo, changes: [] })).toThrow(ProtocolError);
    // A retained rejection is returned again for the same bytes, never re-decided.
    const rejected = room.submit(
      "own",
      envelope("replica-o", 50, 0, [], { undoOf: "replica-x#1" }),
    );
    const again = room.submit("own", envelope("replica-o", 50, 0, [], { undoOf: "replica-x#1" }));
    expect(again.kind === "decided" && again.duplicate ? again.receipt : undefined).toEqual(
      rejected.kind === "decided" ? rejected.receipt : undefined,
    );
  });
});
