import { describe, expect, test } from "bun:test";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { schemaInvariants } from "../../src/core/invariants.ts";
import { wrapText } from "../../src/core/builder-rich.ts";
import { fromTable, ROOT_ID, textOf } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { toTable, createAllocator } from "../../src/core/table.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { childrenDoc, listSchema, textDoc, textUnder } from "../support/docs.ts";
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
    validated ? { validators: [schemaInvariants(listSchema)] } : {},
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

describe("R07–R09 rich-text boundaries, insertion ties, and dependent contexts", () => {
  test("R07 Rich-text changes crossing structural boundaries", () => {
    const parsed = parseDocument(`<doc><p id="p1">Term 10 days.</p></doc>`, richTextSchema);
    if (!parsed.ok) throw new Error("fixture");
    const base = toTable(parsed.value, createAllocator());
    const run = base.get("p1")?.children[0] ?? "";
    const wrap = build(base, "replica-a", 1, (b) => wrapText(b, run, 5, 7, { tag: "emphasis" }));
    const replace = build(base, "replica-b", 1, (b) => b.textReplace(run, 5, 7, "15"));
    for (const order of [
      [wrap, replace],
      [replace, wrap],
    ]) {
      const auth = admit(
        base,
        order.map((changes, i) => ({ replica: `replica-${i}`, changes })),
      ).auth;
      expect(
        serializeDocument(
          fromTable(auth.getTable(), richTextSchema.id, richTextSchema.version),
          richTextSchema,
        ),
      ).toBe('<doc><p id="p1">Term <emphasis>15</emphasis> days.</p></doc>');
    }

    // Split after original c versus deletion of original bcde: both sides of the split are processed.
    for (const text of ["abcdef", "aЁж😀ef"]) {
      const doc = textDoc(text);
      const split = build(doc, "replica-a", 1, (b) => b.split("t", 3));
      const del = build(doc, "replica-b", 1, (b) => b.textDelete("t", 1, 4));
      for (const order of [
        [split, del],
        [del, split],
      ]) {
        const result = admit(
          doc,
          order.map((changes, i) => ({ replica: `replica-${i}`, changes })),
        ).auth.getTable();
        expect(textUnder(result)).toBe([...text][0] + ([...text][5] ?? ""));
        expect(result.get(ROOT_ID)?.children).toHaveLength(2);
      }
      // A replacement crossing the boundary, then merging the runs again.
      const cross = build(doc, "replica-c", 1, (b) => b.textReplace("t", 2, 4, "Z"));
      const auth = admit(doc, [
        { replica: "replica-a", changes: split },
        { replica: "replica-c", changes: cross },
      ]).auth;
      const chars = [...text];
      expect(textUnder(auth.getTable())).toBe(`${chars[0]}${chars[1]}Z${chars[4]}${chars[5]}`);
      const merged = build(auth.getTable(), "replica-a", 2, (b) => b.merge("t"));
      auth.submit(envelope("replica-a", 2, auth.getRevision(), merged), { actor: "replica-a" });
      expect(auth.getTable().get(ROOT_ID)?.children).toEqual(["t"]);
      expect(textOf(auth.getTable().get("t"))).toBe(
        `${chars[0]}${chars[1]}Z${chars[4]}${chars[5]}`,
      );
    }
  });

  test("R08 Concurrent insertion ties remain editable", () => {
    const doc = textDoc("AB");
    const x = {
      replica: "replica-a",
      changes: build(doc, "replica-a", 1, (b) => b.textInsert("t", 1, "X")),
    };
    const y = {
      replica: "replica-b",
      changes: build(doc, "replica-b", 1, (b) => b.textInsert("t", 1, "Y")),
    };
    for (const order of [
      [x, y],
      [y, x],
    ]) {
      const auth = admit(doc, order).auth;
      expect(textOf(auth.getTable().get("t"))).toBe("AXYB");
      // An explicitly addressed later insertion between X and Y keeps its position, whatever its source id.
      for (const replica of ["replica-0", "replica-z"]) {
        const z = build(auth.getTable(), replica, 1, (b) => b.textInsert("t", 2, "Z"));
        expect(textOf(applyChanges(auth.getTable(), z).get("t"))).toBe("AXZYB");
      }
    }
    // Equal-looking values and three contenders in every admission order.
    const same = [x.replica, y.replica, "replica-c"].map((replica) => ({
      replica,
      changes: build(doc, replica, 1, (b) => b.textInsert("t", 1, replica.slice(-1))),
    }));
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const auth = admit(
        doc,
        order.map((i) => same[i] as (typeof same)[number]),
      ).auth;
      expect(textOf(auth.getTable().get("t"))).toBe("AabcB");
    }
    // Child lists: a move into the gap competes with an insertion by stable origin, too.
    const kids = childrenDoc(["A", "B", "M"]);
    const moveIn = {
      replica: "replica-b",
      changes: build(kids, "replica-b", 1, (b) => b.moveNode("M", ROOT_ID, 1)),
    };
    const insert = {
      replica: "replica-a",
      changes: build(
        kids,
        "replica-a",
        1,
        (b) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "X", props: { label: "X" } }),
      ),
    };
    for (const order of [
      [moveIn, insert],
      [insert, moveIn],
    ])
      expect(admit(kids, order).auth.getTable().get(ROOT_ID)?.children).toEqual([
        "A",
        "X",
        "M",
        "B",
      ]);
  });

  test("R09 Dependent pending contexts are propagated correctly", () => {
    for (const deliverTwice of [false, true]) {
      const room = new Room(textDoc("ab"));
      const local = room.join("local", "replica-l");
      const remote = room.join("remote", "replica-r");
      local.transact((b) => b.textInsert("t", 1, "X"));
      local.transact((b) => b.textInsert("t", 2, "Z"));
      remote.transact((b) => b.textInsert("t", 2, "Y"));
      room.send("remote");
      room.send("local");
      const events = [...room.member("local").inbox];
      room.deliver("local");
      if (deliverTwice) local.receive(events);
      // Remote change arrives before the local acknowledgement: both local edits survive once.
      expect(textOf(local.getSnapshot().table.get("t"))).toBe("aXZbY");
      room.settle();
      expect(textOf(room.authority.getTable().get("t"))).toBe("aXZbY");
      expect(textOf(remote.getSnapshot().table.get("t"))).toBe("aXZbY");
    }
    // Create-then-edit chain: the edit depends on the created node, not on the common base.
    const room = new Room(childrenDoc(["A"]));
    const author = room.join("author", "replica-z");
    const other = room.join("other", "replica-a");
    author.transact(
      (b) => void b.insertNode(ROOT_ID, 1, { tag: "item", id: "N", props: { label: "n" } }),
    );
    author.transact((b) => b.set("N", "label", "edited"));
    other.transact(
      (b) => void b.insertNode(ROOT_ID, 0, { tag: "item", id: "P", props: { label: "p" } }),
    );
    room.send("other");
    room.deliver("author");
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.children).toEqual(["P", "A", "N"]);
    expect(room.authority.getTable().get("N")?.props["label"]).toBe("edited");
    // Split-then-edit chain.
    const text = new Room(textDoc("abcd"));
    const splitter = text.join("s", "replica-s");
    const typist = text.join("t", "replica-t");
    let tail = "";
    splitter.transact((b) => void (tail = b.split("t", 2)));
    splitter.transact((b) => b.textInsert(tail, 1, "!"));
    typist.transact((b) => b.textInsert("t", 0, ">"));
    text.send("t");
    text.deliver("s");
    text.settle();
    expect(textUnder(text.authority.getTable())).toBe(">abc!d");
    expect(textUnder(typist.getSnapshot().table)).toBe(">abc!d");
  });
});
