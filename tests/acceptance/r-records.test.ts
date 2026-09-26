import { describe, expect, test } from "bun:test";
import type { ChangeBuilder } from "../../src/core/builder.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import type { Change } from "../../src/core/change.ts";
import { invertChanges } from "../../src/core/change.ts";
import { canonicalJson, decodeChanges } from "../../src/core/change-codec.ts";
import { compose } from "../../src/core/compose.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { ApplyError } from "../../src/core/staging.ts";
import type { Table } from "../../src/core/table.ts";
import { makeRow, ROOT_ID, TEXT_TAG, textOf } from "../../src/core/table.ts";
import { isConflict, rebase } from "../../src/core/transform.ts";
import { typingHistoryPolicy, noCoalescing } from "../../src/core/grouping.ts";
import { items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { tableFrom } from "../support/gen.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const invertProcess = fileURLToPath(new URL("../fixtures/invert-process.ts", import.meta.url));

function rowsOf(table: Table): string {
  return canonicalJson([...table.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
}

/** Invert serialized records in a separate Bun process that has no builder caches or history. */
function invertElsewhere(post: Table, records: readonly Change[]): string {
  const input = JSON.stringify({
    rows: [...post.values()],
    records: JSON.parse(JSON.stringify(records)) as unknown,
  });
  return execFileSync("bun", [invertProcess], { input, encoding: "utf8" });
}

function richBase(): Table {
  return tableFrom([
    makeRow(
      ROOT_ID,
      "doc",
      { items: ["a", "a", { k: [1] }], title: "t", count: 10 },
      null,
      ["p1", "p2"],
      false,
    ),
    makeRow("p1", "p", { note: " spaced  " }, ROOT_ID, ["r1", "e1"], true),
    makeRow("r1", TEXT_TAG, { value: "  lead  ab😀" }, "p1", [], false),
    makeRow("e1", "em", {}, "p1", ["r2"], false),
    makeRow("r2", TEXT_TAG, { value: "inner" }, "e1", [], false),
    makeRow("p2", "p", {}, ROOT_ID, ["r3"], true),
    makeRow("r3", TEXT_TAG, { value: "tail" }, "p2", [], false),
  ]);
}

describe("R10–R15 reversible records, composition, and grouping", () => {
  test("R10 Every supported effective primitive is reversible", () => {
    const base = richBase();
    const cases: [string, (b: ChangeBuilder) => void][] = [
      ["set", (b) => b.set(ROOT_ID, "title", "u")],
      ["remove", (b) => b.set("p1", "note", undefined)],
      ["delta", (b) => b.delta(ROOT_ID, "count", 5)],
      ["arrayInsert", (b) => b.arrayInsert(ROOT_ID, ["items"], 1, ["a"])],
      ["arrayDelete equal occurrence", (b) => b.arrayDelete(ROOT_ID, ["items"], 1)],
      ["arrayMove", (b) => b.arrayMove(ROOT_ID, ["items"], 2, 0)],
      ["nodeInsert", (b) => void b.insertNode("p2", 0, { tag: "em", children: [" x "] })],
      ["nodeDelete subtree", (b) => b.deleteNode("p1")],
      ["nodeMove", (b) => b.moveNode("e1", "p2", 1)],
      ["textInsert", (b) => b.textInsert("r1", 3, "Ω")],
      ["textDelete whitespace", (b) => b.textDelete("r1", 0, 4)],
      ["split", (b) => void b.split("r1", 5)],
      [
        "merge",
        (b) => {
          b.split("r3", 2);
          b.merge("r3");
        },
      ],
    ];
    const records: Change[] = [];
    for (const [, commands] of cases) {
      const changes = build(base, "replica-a", 1, commands);
      expect(changes.length).toBeGreaterThan(0);
      records.push(...changes);
      const post = applyChanges(base, changes);
      // The in-process inverse uses only the deserialized record.
      const decoded = decodeChanges(JSON.parse(JSON.stringify(changes)));
      expect(rowsOf(applyChanges(post, invertChanges(decoded)))).toBe(rowsOf(base));
    }
    // One composite of all cases, inverted in a fresh process.
    const composite = build(base, "replica-a", 2, (b) => {
      for (const [name, commands] of cases) if (!name.startsWith("nodeDelete")) commands(b);
    });
    expect(invertElsewhere(applyChanges(base, composite), composite)).toBe(rowsOf(base));
    expect(new Set(records.map((c) => c.kind)).size).toBe(12);

    // An alreadySatisfied request owns no effect: nothing to invert.
    const auth = Authority.create(DOC, EPOCH, listDoc({ items: ["a", "b"] }));
    const del = build(auth.getTable(), "replica-a", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0));
    auth.submit(envelope("replica-a", 1, 0, del), { actor: "a" });
    const dup = auth.submit(envelope("replica-b", 1, 0, del), { actor: "b" });
    expect(dup.kind === "decided" && dup.receipt.outcome).toBe("alreadySatisfied");
    expect(dup.kind === "decided" && dup.transition).toBeUndefined();
  });

  test("R11 Atomic inverse, effective batches, and backwards history", () => {
    const base = richBase();
    const steps = build(base, "replica-a", 1, (b) => {
      const id = b.insertNode(ROOT_ID, 2, { tag: "p", id: "p3", children: ["new"] });
      b.set(id, "note", "n");
      b.textInsert(b.current().get(id)?.children[0] ?? "", 3, "!");
      b.moveNode("e1", id, 1);
    });
    const post = applyChanges(base, steps);
    expect(rowsOf(applyChanges(post, invertChanges(steps)))).toBe(rowsOf(base));

    // A partially redundant transaction owns only its effective part.
    const auth = Authority.create(DOC, EPOCH, base);
    const other = build(base, "replica-b", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0));
    const mine = build(base, "replica-a", 1, (b) =>
      b.arrayDelete(ROOT_ID, ["items"], 0).set(ROOT_ID, "title", "mine"),
    );
    auth.submit(envelope("replica-b", 1, 0, other), { actor: "b" });
    const decided = auth.submit(envelope("replica-a", 1, 0, mine), { actor: "a" });
    const effective = decided.kind === "decided" ? (decided.transition?.changes ?? []) : [];
    expect(effective.map((c) => c.kind)).toEqual(["set"]);
    expect(items(applyChanges(auth.getTable(), invertChanges(effective)))).toEqual([
      "a",
      { k: [1] },
    ]);

    // Forward and backward replay across retained transitions, with no-op and rejected receipts interleaved.
    const history = Authority.create(DOC, EPOCH, base);
    const oracle = [history.getTable()];
    const commands: ((b: ChangeBuilder) => void)[] = [
      (b) => b.textInsert("r3", 0, ">"),
      (b) => b.deleteNode("e1"),
      (b) => b.arrayDelete(ROOT_ID, ["items"], 1),
      (b) => void b.split("r1", 2),
    ];
    commands.forEach((commands, i) => {
      history.submit(
        envelope(
          "replica-a",
          i * 2 + 1,
          history.getRevision(),
          build(history.getTable(), "replica-a", i * 2 + 1, commands),
        ),
        { actor: "a" },
      );
      history.submit(envelope("replica-a", i * 2 + 2, history.getRevision(), []), { actor: "a" });
      oracle.push(history.getTable());
    });
    history.submit(
      envelope(
        "replica-b",
        1,
        0,
        build(base, "replica-b", 1, (b) => b.set("e1", "x", 1)),
      ),
      { actor: "b" },
    );
    const transitions = history.transitionsSince(0) ?? [];
    expect(transitions).toHaveLength(4);
    let cursor = history.getTable();
    for (let i = transitions.length - 1; i >= 0; i -= 1) {
      cursor = applyChanges(
        cursor,
        invertChanges(decodeChanges(JSON.parse(JSON.stringify(transitions[i]?.changes)))),
      );
      expect(rowsOf(cursor)).toBe(rowsOf(oracle[i] as Table));
    }
    for (const transition of transitions) cursor = applyChanges(cursor, transition.changes);
    expect(rowsOf(cursor)).toBe(rowsOf(history.getTable()));
    // Applying an old inverse where its precondition no longer holds fails explicitly and changes nothing.
    const stale = history.getTable();
    expect(() =>
      applyChanges(
        stale,
        invertChanges(transitions[0]?.changes ?? []).concat(
          invertChanges(transitions[0]?.changes ?? []),
        ),
      ),
    ).toThrow(ApplyError);
    expect(history.getTable()).toBe(stale);
  });

  test("R12 Numeric profile: apply, undo, and arithmetic boundaries", () => {
    const room = new Room(listDoc({ count: 10, x: 0.5, items: ["a"] }), {
      validators: [schemaValidator(listSchema)],
    });
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    a.transact((x) => x.delta(ROOT_ID, "count", 2));
    b.transact((x) => x.delta(ROOT_ID, "count", 3));
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.props["count"]).toBe(15);
    expect(a.undo().status).toBe("requested");
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.props["count"]).toBe(13);
    expect(a.redo().status).toBe("requested");
    const redo = a.nextRequest();
    room.submit("a", redo);
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.props["count"]).toBe(15);
    // Replaying the redo request or its receipt does not repeat arithmetic.
    room.submit("a", redo);
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.props["count"]).toBe(15);

    const auth = room.authority;
    let seq = 100;
    const reject = (changes: unknown[]): string | undefined => {
      seq += 1;
      const d = auth.submit(envelope("replica-z", seq, auth.getRevision(), changes as Change[]), {
        actor: "z",
      });
      return d.kind === "decided" ? d.receipt.reason : d.reason;
    };
    const o = { replica: "replica-z", seq: 1, ordinal: 0 };
    expect(reject([{ kind: "delta", node: ROOT_ID, path: ["x"], by: 1, origin: o }])).toContain(
      "numericProfile",
    );
    expect(
      reject([
        { kind: "delta", node: ROOT_ID, path: ["count"], by: Number.MAX_SAFE_INTEGER, origin: o },
      ]),
    ).toContain("numericProfile");
    expect(() =>
      reject([{ kind: "delta", node: ROOT_ID, path: ["count"], by: 0.1, origin: o }]),
    ).toThrow(ProtocolError);
    expect(() =>
      reject([{ kind: "delta", node: ROOT_ID, path: ["count"], by: 0, origin: o }]),
    ).toThrow(ProtocolError);
    // Relative deltas only on fields the trusted schema declares additive.
    expect(
      reject([{ kind: "delta", node: ROOT_ID, path: ["items"], by: 1, origin: o }]),
    ).toBeDefined();
    expect(auth.getTable().get(ROOT_ID)?.props["count"]).toBe(15);

    // Exact isolated inverse and bounded composition.
    const plusTwo = build(auth.getTable(), "replica-a", 90, (x) => x.delta(ROOT_ID, "count", 2));
    const plusThree = build(applyChanges(auth.getTable(), plusTwo), "replica-a", 91, (x) =>
      x.delta(ROOT_ID, "count", 3),
    );
    expect(compose(plusTwo, plusThree)).toEqual([{ ...plusTwo[0], by: 5 } as Change]);
    const huge = [{ ...plusTwo[0], by: Number.MAX_SAFE_INTEGER } as Change];
    expect(compose(huge, huge)).toHaveLength(2);
  });

  test("R13 Real sequential composition and its limits", () => {
    const doc = textDoc("ab");
    let state = doc;
    const typed: Change[][] = [];
    for (const [i, ch] of ["x", "y", "z"].entries()) {
      const step = build(state, "replica-a", 1 + i, (b) => b.textInsert("t", 1 + i, ch));
      typed.push(step);
      state = applyChanges(state, step);
    }
    const typing = typed.reduce<Change[]>((acc, step) => compose(acc, step), []);
    expect(typing).toHaveLength(1);
    expect(typing[0]).toMatchObject({
      kind: "textInsert",
      offset: 1,
      text: "xyz",
      origin: { seq: 1 },
    });
    expect(textOf(applyChanges(doc, typing).get("t"))).toBe("axyzb");
    expect(
      textOf(
        applyChanges(state, invertChanges(JSON.parse(JSON.stringify(typing)) as Change[])).get("t"),
      ),
    ).toBe("ab");

    const word = textDoc("abcdef");
    const back1 = build(word, "replica-a", 1, (b) => b.textDelete("t", 4, 1));
    const back2 = build(applyChanges(word, back1), "replica-a", 2, (b) => b.textDelete("t", 3, 1));
    const backspaces = compose(back1, back2);
    expect(backspaces).toEqual([{ ...back1[0], offset: 3, text: "de" } as Change]);
    expect(
      textOf(applyChanges(applyChanges(word, backspaces), invertChanges(backspaces)).get("t")),
    ).toBe("abcdef");

    const numbers = listDoc({ x: 10 });
    const s1 = build(numbers, "replica-a", 1, (b) => b.set(ROOT_ID, "x", 11));
    const s2 = build(applyChanges(numbers, s1), "replica-a", 2, (b) => b.set(ROOT_ID, "x", 14));
    const chain = compose(s1, s2);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ before: 10, after: 14 });
    expect(
      applyChanges(applyChanges(numbers, chain), invertChanges(chain)).get(ROOT_ID)?.props["x"],
    ).toBe(10);

    // Rebased composition: its inverse restores that branch's actual base.
    const remote = build(numbers, "replica-b", 1, (b) => b.set(ROOT_ID, "title", "r"));
    const rebased = rebase(chain, remote);
    if (isConflict(rebased)) throw new Error("compatible");
    const branch = applyChanges(numbers, remote);
    expect(rowsOf(applyChanges(applyChanges(branch, rebased), invertChanges(rebased)))).toBe(
      rowsOf(branch),
    );
    // A structural change stays a reversible composite of parts (no unproven simplification).
    const mixed = compose(
      s1,
      build(applyChanges(numbers, s1), "replica-a", 3, (b) => b.set(ROOT_ID, "title", "t")),
    );
    expect(mixed).toHaveLength(2);
  });

  test("R14 Coalescing stops at the sent-request boundary", () => {
    const room = new Room(textDoc("ab"));
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    for (const [i, ch] of ["h", "e", "y"].entries())
      a.transact((x) => x.textInsert("t", 1 + i, ch));
    expect(a.getStatus().unsent).toHaveLength(1);
    const sent = a.nextRequest();
    expect(sent?.changes).toHaveLength(1);
    expect(sent?.changes[0]).toMatchObject({
      kind: "textInsert",
      text: "hey",
      origin: { replica: "replica-a", seq: 1 },
    });
    expect(sent?.meta.packed).toEqual([2, 3]);
    const bytes = canonicalJson(sent);
    // Later typing is not merged into the in-flight request.
    a.transact((x) => x.textInsert("t", 4, "!"));
    expect(a.getStatus().unsent).toHaveLength(1);
    // A remote change rebases the working form, never the submitted bytes.
    b.transact((x) => x.textInsert("t", 0, ">"));
    room.send("b");
    room.deliver("a");
    expect(a.state.pending[0]?.working[0]).toMatchObject({ offset: 2 });
    expect(canonicalJson(a.resend())).toBe(bytes);
    const parsedBytes = JSON.parse(bytes) as { changes: object[] };
    const tampered = {
      ...parsedBytes,
      changes: [{ ...parsedBytes.changes[0], text: "HEY" }],
    };
    room.submit("a", a.resend());
    expect(() => room.submit("a", tampered)).toThrow(ProtocolError);
    room.settle();
    expect(textOf(room.authority.getTable().get("t"))).toBe(">ahey!b");

    // Successive sets of one field inside a gesture compress to one before→after record.
    const drag = new Room(listDoc({ x: 0 }));
    const dragger = drag.join("d", "replica-d");
    dragger.beginGroup("drag");
    for (const x of [1, 2, 3]) dragger.transact((y) => y.set(ROOT_ID, "x", x));
    expect(dragger.nextRequest()?.changes).toEqual([
      expect.objectContaining({ kind: "set", before: 0, after: 3 }),
    ]);
  });

  test("R15 User grouping is independent of transport batching", () => {
    let now = 0;
    const room = new Room(textDoc("ab"));
    const a = room.join("a", "replica-a", "alice", {
      now: () => now,
      historyPolicy: typingHistoryPolicy(1000),
      coalescing: noCoalescing,
    });
    const b = room.join("b", "replica-b", "bob");
    const type = (offset: number, ch: string): string => {
      const result = a.transact((x) => x.textInsert("t", offset, ch));
      return result.status === "applied" ? result.group : "";
    };
    const g1 = type(1, "x");
    now = 500;
    expect(type(2, "y")).toBe(g1); // adjacent, within the gap
    now = 2000;
    const g2 = type(3, "z"); // outside the gap
    expect(g2).not.toBe(g1);
    now = 2100;
    const g3 = type(1, "q"); // not adjacent
    expect(g3).not.toBe(g2);
    now = 2200;
    a.closeGroup();
    const g4 = type(2, "w");
    expect(g4).not.toBe(g3);
    // An applied remote change closes the automatic group; clock skew is irrelevant to ordering.
    room.settle();
    b.transact((x) => x.textInsert("t", 0, "<"));
    room.settle();
    now = 2300;
    expect(type(4, "v")).not.toBe(g4);
    room.settle();

    // An explicit drag group spans already-sent transactions and remote activity.
    a.beginGroup("drag");
    const drag = type(1, "1");
    room.settle();
    b.transact((x) => x.textInsert("t", 0, "#"));
    room.settle();
    expect(type(3, "2")).toBe(drag);
    room.settle();
    a.endGroup();
    expect(a.history.get(drag)?.members).toHaveLength(2);
    const before = textOf(room.authority.getTable().get("t"));
    expect(a.undo().status).toBe("requested");
    room.settle();
    expect(textOf(room.authority.getTable().get("t"))).toBe(
      before.replace("1", "").replace("2", ""),
    );

    // Two actors using the same label never merge ownership.
    a.beginGroup("task");
    b.beginGroup("task");
    const ga = type(0, "A");
    const gb = b.transact((x) => x.textInsert("t", 0, "B"));
    expect(gb.status === "applied" && gb.group).not.toBe(ga);
    // One publication batch may carry several distinct remote actions.
    room.send("a");
    room.send("b");
    let commits = 0;
    const c = room.join("c", "replica-c");
    c.receive(room.authority.transitionsSince(0) ?? []);
    const off = c.subscribeCommits(() => (commits += 1));
    c.receive(room.member("c").inbox.splice(0));
    off();
    expect(commits).toBeLessThanOrEqual(1);
  });
});
