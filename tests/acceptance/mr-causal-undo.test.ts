import { describe, expect, test } from "bun:test";
import { Client, type ContentItem } from "../../src/index.ts";
import { CausalProbe, rich, typePlainBoldPlain } from "../support/causal-history.ts";

const SPAN = (text: string, props = { bold: true }): ContentItem => ({
  tag: "span",
  props,
  content: [text],
});

/** The first child of `node` in the authority's table (a created text run or span). */
function child(probe: CausalProbe, node: string, index: number): string {
  const id = probe.room.authority.getTable().get(node)?.children[index];
  if (id === undefined) throw new Error(`no child ${index} of ${node}`);
  return id;
}

/** Full undo back to `initial`, then full redo back to `final`, each step accepted. */
function roundTrip(probe: CausalProbe, initial: unknown, final: unknown, read?: () => unknown) {
  const undone = probe.exhaust("undo", read);
  expect(undone.at(-1)).toEqual(initial);
  const redone = probe.exhaust("redo", read);
  expect(redone.at(-1)).toEqual(final);
  expect(redone.length).toBe(undone.length);
  probe.converged();
  return { undone, redone };
}

describe("MR45 causal own undo across dependent text and subtree groups", () => {
  test("MR45 Created text run edited by a later own group undoes and redoes fully", () => {
    const probe = new CausalProbe();
    let run = "";
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.transact((b) => b.textInsert(run, 1, "вост"));
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало х"]);
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало "]);
    expect(probe.restore("redo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало х"]);
    expect(probe.restore("redo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало хвост"]);
    probe.converged();
  });

  test("MR45 Plain/bold/plain typing with the default typing policy", () => {
    const probe = new CausalProbe();
    typePlainBoldPlain(probe);
    const final = rich("Начало обычный ", "жирный ", "хвост");
    expect(probe.content()).toEqual(final);
    const { undone, redone } = roundTrip(probe, ["Начало "], final);
    // Undo walks back through the authored order: tail, then bold, then plain text.
    const tailGone = undone.findIndex((state) => (state as ContentItem[]).length === 2);
    const boldGone = undone.findIndex((state) => (state as ContentItem[]).length === 1);
    expect(tailGone).toBeGreaterThan(0);
    expect(boldGone).toBeGreaterThan(tailGone);
    expect(undone[boldGone]).toEqual(["Начало обычный "]);
    expect(redone).toEqual([...undone.slice(0, -1).reverse(), final]);
  });

  test("MR45 Plain/bold/plain typing with explicit segment groups", () => {
    const probe = new CausalProbe();
    typePlainBoldPlain(probe, true);
    const { undone } = roundTrip(probe, ["Начало "], rich("Начало обычный ", "жирный ", "хвост"));
    expect(undone).toEqual([rich("Начало обычный ", "жирный "), ["Начало обычный "], ["Начало "]]);
  });

  test("MR45 Pause and caret-movement boundaries inside a new run and a new span", () => {
    const probe = new CausalProbe();
    let run = "";
    probe.writer.beginGroup("first burst");
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.transact((b) => b.textInsert(run, 1, "во"));
    probe.writer.endGroup();
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 3, "ст"));
    // Caret moves back to the start of the run: a non-contiguous typing burst.
    probe.transact((b) => b.textInsert(run, 0, "«"));
    let span = "";
    probe.transact((b) => {
      span = b.insertNode("paragraph", 2, { tag: "span", props: { bold: true }, children: ["!"] });
    });
    probe.advance(1500);
    probe.transact((b) => b.textInsert(child(probe, span, 0), 1, "?"));
    const final = ["Начало «хвост", SPAN("!?")];
    expect(probe.content()).toEqual(final);
    const { undone } = roundTrip(probe, ["Начало "], final);
    expect(undone).toEqual([
      ["Начало «хвост", SPAN("!")],
      ["Начало «хвост"],
      ["Начало хвост"],
      ["Начало хво"],
      ["Начало "],
    ]);
  });

  test("MR45 New anonymous span: child edits undo before its creation", () => {
    const probe = new CausalProbe();
    probe.replace(["Начало ", SPAN("ж")]);
    const span = child(probe, "paragraph", 1);
    const text = child(probe, span, 0);
    probe.advance(1500);
    probe.transact((b) => b.textInsert(text, 1, "ирный"));
    probe.advance(1500);
    probe.transact((b) => b.textDelete(text, 0, 1));
    probe.advance(1500);
    probe.transact((b) => b.set(span, "italic", true));
    const final = ["Начало ", SPAN("ирный", { bold: true, italic: true } as never)];
    expect(probe.content()).toEqual(final);
    const { undone } = roundTrip(probe, ["Начало "], final);
    expect(undone).toEqual([
      ["Начало ", SPAN("ирный")],
      ["Начало ", SPAN("жирный")],
      ["Начало ", SPAN("ж")],
      ["Начало "],
    ]);
  });

  test("MR45 Insert/delete/replace bursts with Unicode, empty runs and a removed span", () => {
    const probe = new CausalProbe();
    let run = "";
    let empty = "";
    const step = (write: Parameters<CausalProbe["transact"]>[0]) => {
      probe.advance(1500);
      probe.transact(write);
    };
    step((b) => {
      run = b.insertNode("paragraph", 1, { tag: "span", props: { bold: true }, children: ["ё"] });
    });
    const text = child(probe, run, 0);
    step((b) => b.textInsert(text, 1, "ж👩🏽‍🚀é"));
    step((b) => {
      empty = b.insertNode("paragraph", 2, "");
    });
    step((b) => b.textInsert(empty, 0, "中文"));
    step((b) => b.textReplace(text, 1, 2, "Ж"));
    step((b) => b.textDelete(empty, 0, 2));
    step((b) => b.deleteNode(run));
    const seen = probe.content();
    const { undone, redone } = roundTrip(probe, ["Начало "], seen);
    expect(undone).toContainEqual(["Начало ", SPAN("ёЖ👩🏽‍🚀é"), "中文"]);
    expect(undone).toContainEqual(["Начало ", SPAN("ёж👩🏽‍🚀é"), "中文"]);
    expect(redone.length).toBe(7);
  });

  test("MR45 Fresh editing after undo clears redo but keeps earlier groups undoable", () => {
    const probe = new CausalProbe();
    let run = "";
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 1, "вост"));
    expect(probe.restore("undo").status).toBe("requested");
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 1, "ор"));
    expect(probe.content()).toEqual(["Начало хор"]);
    // Documented policy: fresh work discards the undone branch.
    expect(probe.restore("redo").status).toBe("unavailable");
    expect(probe.exhaust("undo")).toEqual([["Начало х"], ["Начало "]]);
    probe.converged();
  });

  test("MR45 Unrelated remote edits survive own causal undo/redo", () => {
    const probe = new CausalProbe([["Начало "], ["Чужой"]]);
    const other = child(probe, "paragraph-1", 0);
    let run = "";
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.remote((b) => b.textInsert(other, 5, " текст"));
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 1, "вост"));
    probe.remote((b) => b.textInsert(other, 0, "+"));
    const { undone } = roundTrip(probe, ["Начало "], ["Начало хвост"]);
    expect(undone).toEqual([["Начало х"], ["Начало "]]);
    expect(probe.paragraph(1)).toEqual(["+Чужой текст"]);
  });

  test("MR45 Remote edits inside the created run block its undo and are never deleted", () => {
    const probe = new CausalProbe();
    let run = "";
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 1, "во"));
    probe.remote((b) => b.textInsert(run, 3, "Р"));
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 4, "ст"));
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало хвоР"]);
    // The own insertion before the remote one is independent and still cancellable.
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.content()).toEqual(["Начало хР"]);
    // Deleting the run would delete the collaborator's text: a justified, atomic conflict.
    expect(probe.restore("undo")).toMatchObject({
      status: "conflict",
      reason: "the deletion would remove concurrently edited content",
    });
    expect(probe.content()).toEqual(["Начало хР"]);
    expect(probe.exhaust("redo")).toEqual([["Начало хвоР"], ["Начало хвоРст"]]);
    probe.converged();
  });

  test("MR45 Control: separate groups appending to a pre-existing run", () => {
    const probe = new CausalProbe();
    probe.replace(["Начало один"]);
    probe.advance(1500);
    probe.replace(["Начало один два"]);
    const { undone } = roundTrip(probe, ["Начало "], ["Начало один два"]);
    expect(undone).toEqual([["Начало один"], ["Начало "]]);
  });

  test("MR45 Recovery state survives a session export and restore", () => {
    const probe = new CausalProbe();
    let run = "";
    probe.transact((b) => {
      run = b.insertNode("paragraph", 1, "х");
    });
    probe.advance(1500);
    probe.transact((b) => b.textInsert(run, 1, "вост"));
    expect(probe.restore("undo").status).toBe("requested");
    const session = JSON.parse(JSON.stringify(probe.writer.exportSession())) as ReturnType<
      Client["exportSession"]
    >;
    const restored = new Client({
      ...probe.writer.options,
      table: probe.room.authority.getTable(),
      revision: probe.room.authority.getRevision(),
      restore: session,
    });
    probe.room.adopt("writer", "writer", restored);
    const result = restored.undo();
    expect(result.status).toBe("requested");
    probe.room.settle();
    expect(probe.content()).toEqual(["Начало "]);
  });
});

describe("MR46 causal own undo across sequential writes to one shared field", () => {
  const names = ["Первое имя", "Второе имя", "Третье имя"];

  test("MR46 Sequential own writes to an absent field undo to absence and redo in order", () => {
    const probe = new CausalProbe();
    for (const name of names) probe.transact((b) => b.set("paragraph", "name", name));
    const read = () => probe.props()["name"] ?? null;
    const { undone, redone } = roundTrip(probe, null, "Третье имя", read);
    expect(undone).toEqual(["Второе имя", "Первое имя", null]);
    expect(redone).toEqual(["Первое имя", "Второе имя", "Третье имя"]);
    expect("name" in probe.props()).toBe(true);
  });

  test("MR46 Pre-existing name, description and typed default keep identity and values", () => {
    const initial = { name: "Заказчик", description: "", defaultValue: 0, required: false };
    const probe = new CausalProbe([["Начало "]], initial);
    const before = probe.room.authority.getTable().get("paragraph");
    const edits: [string, unknown][] = [
      ["name", "Первое имя"],
      ["description", "Сторона договора"],
      ["name", "Второе имя"],
      ["defaultValue", 15],
      ["required", true],
      ["defaultValue", 0],
      ["name", "Третье имя"],
      ["description", ""],
    ];
    for (const [field, value] of edits) {
      probe.advance(1500);
      probe.transact((b) => b.set("paragraph", field, value as never));
    }
    const final = probe.props();
    expect(final).toEqual({ name: "Третье имя", description: "", defaultValue: 0, required: true });
    const { undone } = roundTrip(probe, initial, final, () => probe.props());
    expect(undone.map((props) => (props as typeof initial).name)).toEqual([
      "Третье имя",
      "Второе имя",
      "Второе имя",
      "Второе имя",
      "Второе имя",
      "Первое имя",
      "Первое имя",
      "Заказчик",
    ]);
    expect(undone[2]).toMatchObject({ defaultValue: 15, required: true });
    expect(undone[3]).toMatchObject({ defaultValue: 15, required: false });
    const after = probe.room.authority.getTable().get("paragraph");
    expect(after?.id).toBe(before?.id);
    expect(after?.children).toEqual(before?.children);
  });

  test("MR46 Repeated undo/redo cycles and partial redo followed by fresh work", () => {
    const probe = new CausalProbe([["Начало "]], { name: "Заказчик" });
    for (const name of names) probe.transact((b) => b.set("paragraph", "name", name));
    const read = () => probe.props()["name"];
    for (let cycle = 0; cycle < 3; cycle += 1) roundTrip(probe, "Заказчик", "Третье имя", read);
    probe.exhaust("undo", read);
    expect(probe.restore("redo").status).toBe("requested");
    probe.transact((b) => b.set("paragraph", "name", "Новое имя"));
    expect(probe.restore("redo").status).toBe("unavailable");
    expect(probe.exhaust("undo", read)).toEqual(["Первое имя", "Заказчик"]);
  });

  test("MR46 A collaborator's write between own writes stays protected", () => {
    const probe = new CausalProbe([["Начало "]], { name: "Заказчик" });
    probe.transact((b) => b.set("paragraph", "name", "Первое имя"));
    probe.remote((b) => b.set("paragraph", "name", "Чужое имя"));
    probe.transact((b) => b.set("paragraph", "name", "Второе имя"));
    probe.transact((b) => b.set("paragraph", "description", "Описание"));
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.restore("undo").status).toBe("requested");
    expect(probe.props()["name"]).toBe("Чужое имя");
    // Undoing the first write would overwrite the collaborator's value.
    expect(probe.restore("undo")).toMatchObject({
      status: "conflict",
      reason: "concurrent writes to the same field",
    });
    expect(probe.props()["name"]).toBe("Чужое имя");
    probe.converged();
  });
});
