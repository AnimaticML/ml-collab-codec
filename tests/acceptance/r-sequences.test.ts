import { describe, expect, test } from "bun:test";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { isConflict, transformPair } from "../../src/core/transform.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

function outcome(decision: Decision): string {
  return decision.kind === "decided" ? decision.receipt.outcome : decision.kind;
}

function authority(table: Table, validated = false): Authority {
  return Authority.create(
    DOC,
    EPOCH,
    table,
    validated ? { validators: [schemaValidator(listSchema)] } : {},
  );
}

/** Submit concurrent requests (all based on revision 0) in the given authority order. */
function admit(
  table: Table,
  requests: readonly { replica: string; changes: ReturnType<typeof build> }[],
  validated = false,
) {
  const auth = authority(table, validated);
  const outcomes = requests.map((r, i) =>
    outcome(auth.submit(envelope(r.replica, i + 1, 0, r.changes), { actor: r.replica })),
  );
  return { auth, outcomes };
}

describe("R01–R06 occurrence identity and sequence transformation", () => {
  test("R01 Same duplicate occurrence deleted twice", () => {
    for (const base of [
      ["a", "a", "b"],
      [{ n: 1 }, { n: 1 }, { n: 2 }],
    ]) {
      const table = listDoc({ items: base });
      const removeFirst = (replica: string) => ({
        replica,
        changes: build(table, replica, 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0)),
      });
      const { auth, outcomes } = admit(table, [removeFirst("replica-a"), removeFirst("replica-b")]);
      expect(outcomes).toEqual(["applied", "alreadySatisfied"]);
      // The remaining equal occurrence is not searched for and removed.
      expect(items(auth.getTable())).toEqual(base.slice(1));
      expect(auth.getRevision()).toBe(1);
      // Duplicate network delivery is a different case: the same request id returns its receipt.
      const retry = auth.submit(envelope("replica-a", 1, 0, removeFirst("replica-a").changes), {
        actor: "replica-a",
      });
      expect(retry.kind === "decided" && retry.duplicate).toBe(true);
      expect(outcome(retry)).toBe("applied");
      expect(items(auth.getTable())).toEqual(base.slice(1));
      expect(auth.getRevision()).toBe(1);
    }
  });

  test("R01 Same duplicate occurrence deleted twice through three live clients", () => {
    const room = new Room(listDoc({ items: ["a", "a", "b"] }));
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    room.join("c", "replica-c");
    a.transact((x) => x.arrayDelete(ROOT_ID, ["items"], 0));
    b.transact((x) => x.arrayDelete(ROOT_ID, ["items"], 0));
    room.settle();
    for (const name of ["a", "b", "c"])
      expect(items(room.client(name).getSnapshot().table)).toEqual(["a", "b"]);
    expect(room.decisions.map(outcome)).toEqual(["applied", "alreadySatisfied"]);
  });

  test("R02 Distinct duplicate occurrences and intervening edits", () => {
    const table = listDoc({ items: ["a", "a", "b"] });
    const del = (replica: string, index: number) => ({
      replica,
      changes: build(table, replica, 1, (b) => b.arrayDelete(ROOT_ID, ["items"], index)),
    });
    const both = admit(table, [del("replica-a", 0), del("replica-b", 1)]);
    expect(both.outcomes).toEqual(["applied", "applied"]);
    expect(items(both.auth.getTable())).toEqual(["b"]);

    const prefix = {
      replica: "replica-c",
      changes: build(table, "replica-c", 1, (b) => b.arrayInsert(ROOT_ID, ["items"], 0, ["z"])),
    };
    const shifted = admit(table, [prefix, del("replica-a", 0), del("replica-b", 1)]);
    expect(shifted.outcomes).toEqual(["applied", "applied", "applied"]);
    expect(items(shifted.auth.getTable())).toEqual(["z", "b"]);

    // Delete/edit conflict on one object occurrence never touches its equal neighbour.
    const objects = listDoc({ items: [{ n: 1 }, { n: 1 }] });
    const edit = {
      replica: "replica-a",
      changes: build(objects, "replica-a", 1, (b) => b.set(ROOT_ID, ["items", 1, "n"], 5)),
    };
    const remove = {
      replica: "replica-b",
      changes: build(objects, "replica-b", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 1)),
    };
    const editFirst = admit(objects, [edit, remove]);
    expect(editFirst.outcomes).toEqual(["applied", "rejected"]);
    expect(items(editFirst.auth.getTable())).toEqual([{ n: 1 }, { n: 5 }]);
    const removeFirst = admit(objects, [remove, edit]);
    expect(removeFirst.outcomes).toEqual(["applied", "rejected"]);
    expect(items(removeFirst.auth.getTable())).toEqual([{ n: 1 }]);
  });

  test("R03 Concurrent insertions inside deleted original ranges", () => {
    const text = textDoc("abcd");
    const del = build(text, "replica-a", 1, (b) => b.textDelete("t", 1, 2));
    const ins = build(text, "replica-b", 1, (b) => b.textInsert("t", 2, "X"));
    const pair = transformPair(del, ins);
    if (isConflict(pair)) throw new Error("compatible pair reported a conflict");
    const afterInsert = applyChanges(text, ins);
    expect(textOf(afterInsert.get("t"))).toBe("abXcd");
    // Through abXcd the rebased deletion removes original c and b, never the inserted X.
    expect(pair.a.map((c) => (c.kind === "textDelete" ? [c.offset, c.text] : c.kind))).toEqual([
      [3, "c"],
      [1, "b"],
    ]);
    expect(textOf(applyChanges(afterInsert, pair.a).get("t"))).toBe("aXd");
    expect(textOf(applyChanges(applyChanges(text, del), pair.b).get("t"))).toBe("aXd");
    for (const order of [
      [del, ins],
      [ins, del],
    ]) {
      const { auth } = admit(
        text,
        order.map((changes, i) => ({ replica: `replica-${i}`, changes })),
      );
      expect(textOf(auth.getTable().get("t"))).toBe("aXd");
    }

    const list = listDoc({ items: ["a", "b", "c", "d"] });
    const arrDel = build(list, "replica-a", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 1, 2));
    const arrIns = build(list, "replica-b", 1, (b) => b.arrayInsert(ROOT_ID, ["items"], 2, ["X"]));
    for (const order of [
      [arrDel, arrIns],
      [arrIns, arrDel],
    ]) {
      const { auth } = admit(
        list,
        order.map((changes, i) => ({ replica: `replica-${i}`, changes })),
      );
      expect(items(auth.getTable())).toEqual(["a", "X", "d"]);
    }

    // Multiple inserted runs: every expanded component must be applied.
    const wide = textDoc("abcdef");
    const wideDel = build(wide, "replica-a", 1, (b) => b.textDelete("t", 1, 4));
    const twoRuns = build(wide, "replica-b", 1, (b) =>
      b.textInsert("t", 2, "X").textInsert("t", 5, "Y"),
    );
    const widePair = transformPair(wideDel, twoRuns);
    if (isConflict(widePair)) throw new Error("compatible pair reported a conflict");
    expect(widePair.a).toHaveLength(3);
    expect(textOf(applyChanges(applyChanges(wide, twoRuns), widePair.a).get("t"))).toBe("aXYf");
    const overlapping = build(wide, "replica-c", 1, (b) => b.textDelete("t", 3, 3));
    const { auth } = admit(wide, [
      { replica: "replica-a", changes: wideDel },
      { replica: "replica-b", changes: twoRuns },
      { replica: "replica-c", changes: overlapping },
    ]);
    expect(textOf(auth.getTable().get("t"))).toBe("aXY");
  });

  test("R04 Nested array paths and occurrence movement", () => {
    const table = listDoc({
      items: [
        { name: "a", tags: ["x"] },
        { name: "a", tags: ["x", "y"] },
      ],
    });
    const prefix = {
      replica: "replica-a",
      changes: build(table, "replica-a", 1, (b) =>
        b.arrayInsert(ROOT_ID, ["items"], 0, [{ name: "p", tags: [] }]),
      ),
    };
    const editSecond = {
      replica: "replica-b",
      changes: build(table, "replica-b", 1, (b) => b.set(ROOT_ID, ["items", 1, "name"], "b")),
    };
    const { auth } = admit(table, [prefix, editSecond]);
    expect(items(auth.getTable())).toEqual([
      { name: "p", tags: [] },
      { name: "a", tags: ["x"] },
      { name: "b", tags: ["x", "y"] },
    ]);

    // Move of an occurrence plus an edit inside it.
    const move = {
      replica: "replica-a",
      changes: build(table, "replica-a", 1, (b) => b.arrayMove(ROOT_ID, ["items"], 1, 0)),
    };
    const inner = {
      replica: "replica-b",
      changes: build(table, "replica-b", 1, (b) =>
        b.arrayInsert(ROOT_ID, ["items", 1, "tags"], 0, ["w"]),
      ),
    };
    for (const order of [
      [move, inner],
      [inner, move],
    ]) {
      const result = admit(table, order).auth.getTable();
      expect(items(result)).toEqual([
        { name: "a", tags: ["w", "x", "y"] },
        { name: "a", tags: ["x"] },
      ]);
    }

    // Indexes change at two path segments: outer prefix insert and inner insert before the edited tag.
    const innerInsert = {
      replica: "replica-c",
      changes: build(table, "replica-c", 1, (b) =>
        b.arrayInsert(ROOT_ID, ["items", 1, "tags"], 0, ["w"]),
      ),
    };
    const tagEdit = {
      replica: "replica-d",
      changes: build(table, "replica-d", 1, (b) => b.set(ROOT_ID, ["items", 1, "tags", 1], "Y")),
    };
    const nested = admit(table, [prefix, innerInsert, tagEdit]).auth.getTable();
    expect(items(nested)).toEqual([
      { name: "p", tags: [] },
      { name: "a", tags: ["x"] },
      { name: "a", tags: ["w", "x", "Y"] },
    ]);
  });

  test("R05 Authoritative invariants and correct no-op classification", () => {
    const table = listDoc({ items: ["a", "b"] });
    const del = (replica: string, index: number) => ({
      replica,
      changes: build(table, replica, 1, (b) => b.arrayDelete(ROOT_ID, ["items"], index)),
    });
    const aFirst = admit(table, [del("replica-a", 0), del("replica-b", 1)], true);
    expect(aFirst.outcomes).toEqual(["applied", "rejected"]);
    expect(items(aFirst.auth.getTable())).toEqual(["b"]);
    const bFirst = admit(table, [del("replica-b", 1), del("replica-a", 0)], true);
    expect(bFirst.outcomes).toEqual(["applied", "rejected"]);
    expect(items(bFirst.auth.getTable())).toEqual(["a"]);
    const same = admit(table, [del("replica-a", 0), del("replica-b", 0)], true);
    expect(same.outcomes).toEqual(["applied", "alreadySatisfied"]);
    expect(items(same.auth.getTable())).toEqual(["b"]);

    const twins = listDoc({ items: ["a", "a"] });
    const delTwin = (replica: string, index: number) => ({
      replica,
      changes: build(twins, replica, 1, (b) => b.arrayDelete(ROOT_ID, ["items"], index)),
    });
    expect(admit(twins, [delTwin("replica-a", 0), delTwin("replica-b", 0)], true).outcomes).toEqual(
      ["applied", "alreadySatisfied"],
    );
    const distinct = admit(twins, [delTwin("replica-a", 0), delTwin("replica-b", 1)], true);
    expect(distinct.outcomes).toEqual(["applied", "rejected"]);
    expect(items(distinct.auth.getTable())).toEqual(["a"]);

    // A client-supplied limit cannot weaken the schema: unknown fields are refused before mutation.
    const weakened = { ...del("replica-a", 0).changes[0], minItems: 0 };
    const guard = authority(table, true);
    expect(() =>
      guard.submit(envelope("replica-a", 1, 0, [weakened as never]), { actor: "replica-a" }),
    ).toThrow(ProtocolError);
    expect(items(guard.getTable())).toEqual(["a", "b"]);

    // A staged replacement may be temporarily empty when the final candidate is valid.
    const single = listDoc({ items: ["a"] });
    const replace = build(single, "replica-a", 1, (b) =>
      b.arrayDelete(ROOT_ID, ["items"], 0).arrayInsert(ROOT_ID, ["items"], 0, ["z"]),
    );
    const staged = admit(single, [{ replica: "replica-a", changes: replace }], true);
    expect(staged.outcomes).toEqual(["applied"]);
    expect(items(staged.auth.getTable())).toEqual(["z"]);
  });

  test("R06 Old-value preconditions are not target search", () => {
    const table = listDoc({ items: ["a", "b", "a"] });
    const delLast = {
      replica: "replica-a",
      changes: build(table, "replica-a", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 2)),
    };
    const delFirst = {
      replica: "replica-b",
      changes: build(table, "replica-b", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0)),
    };
    const setFirst = {
      replica: "replica-c",
      changes: build(table, "replica-c", 1, (b) => b.set(ROOT_ID, ["items", 0], "A")),
    };
    const run = admit(table, [delFirst, setFirst, delLast]);
    // The stale update of the removed first "a" conflicts; it is not redirected to the other "a".
    expect(run.outcomes).toEqual(["applied", "rejected", "applied"]);
    expect(items(run.auth.getTable())).toEqual(["b"]);

    // Recorded old values are checked preconditions: a forged before-value is diagnosed.
    const forged = { ...setFirst.changes[0], before: "zzz" };
    const tamper = authority(table);
    const decision = tamper.submit(envelope("replica-c", 1, 0, [forged as never]), {
      actor: "replica-c",
    });
    expect(outcome(decision)).toBe("rejected");
    expect(decision.kind === "decided" ? decision.receipt.reason : "").toContain(
      "preconditionFailed",
    );

    // Whole-value set versus nested edit of the same object occurrence conflicts.
    const objects = listDoc({ items: [{ name: "x" }] });
    const whole = {
      replica: "replica-a",
      changes: build(objects, "replica-a", 1, (b) => b.set(ROOT_ID, ["items", 0], { name: "w" })),
    };
    const nested = {
      replica: "replica-b",
      changes: build(objects, "replica-b", 1, (b) => b.set(ROOT_ID, ["items", 0, "name"], "n")),
    };
    expect(admit(objects, [whole, nested]).outcomes).toEqual(["applied", "rejected"]);

    // A stale address is resolved in its base, then mapped: index 2 at revision 0 is index 3 now.
    const shift = authority(table);
    shift.submit(
      envelope(
        "replica-a",
        1,
        0,
        build(table, "replica-a", 1, (b) => b.arrayInsert(ROOT_ID, ["items"], 0, ["q"])),
      ),
      { actor: "replica-a" },
    );
    shift.submit(
      envelope(
        "replica-b",
        1,
        0,
        build(table, "replica-b", 1, (b) => b.set(ROOT_ID, ["items", 2], "LAST")),
      ),
      { actor: "replica-b" },
    );
    expect(items(shift.getTable())).toEqual(["q", "a", "b", "LAST"]);
  });
});
