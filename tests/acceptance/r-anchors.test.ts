import { describe, expect, test } from "bun:test";
import type { ChangeBuilder } from "../../src/core/builder.ts";
import { anchoredContent, mapAnchor, mapAnchorFrom } from "../../src/core/anchors.ts";
import type { Anchor } from "../../src/core/anchors.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import { unwrap, wrapText } from "../../src/core/builder-rich.ts";
import type { Change } from "../../src/core/change.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { proposeEdit, rebaseProposal } from "../../src/core/proposal.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import {
  createAllocator,
  fromTable,
  makeRow,
  ROOT_ID,
  TEXT_TAG,
  toTable,
} from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { tableFrom } from "../support/gen.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";

function doc(): Table {
  return tableFrom([
    makeRow(ROOT_ID, "doc", { items: ["a", "a", "b"] }, null, ["p1", "p2"], false),
    makeRow("p1", "p", {}, ROOT_ID, ["r1"], true),
    makeRow("r1", TEXT_TAG, { value: "hello world" }, "p1", [], false),
    makeRow("p2", "p", {}, ROOT_ID, ["r2"], true),
    makeRow("r2", TEXT_TAG, { value: "hello world" }, "p2", [], false),
  ]);
}

/** Apply a sequence of builder steps, collecting the reversible mapping. */
function run(
  table: Table,
  ...steps: ((b: ChangeBuilder) => void)[]
): { table: Table; mapping: Change[] } {
  let current = table;
  const mapping: Change[] = [];
  steps.forEach((step, i) => {
    const changes = build(current, "replica-a", i + 1, step);
    current = applyChanges(current, changes);
    mapping.push(...changes);
  });
  return { table: current, mapping };
}

function mapped(anchor: Anchor, mapping: readonly Change[]): Anchor {
  const result = mapAnchor(anchor, mapping);
  if (result.status !== "mapped") throw new Error(`anchor ${result.status}: ${result.reason}`);
  return result.anchor;
}

describe("R27–R29 anchors, affinity, and base-aware proposals", () => {
  test("R27 Anchors follow surviving content through structure", () => {
    const node: Anchor = { kind: "node", node: "p1" };
    const occurrence: Anchor = { kind: "occurrence", node: ROOT_ID, path: ["items"], index: 2 };
    const point: Anchor = { kind: "point", node: "r1", offset: 6, affinity: "before" };
    const range: Anchor = { kind: "range", segments: [{ node: "r1", from: 0, to: 5 }] };
    let tail = "";
    let wrapper = "";
    const { table, mapping } = run(
      doc(),
      (b) => b.arrayInsert(ROOT_ID, ["items"], 0, ["z"]),
      (b) => b.textInsert("r1", 0, ">> "),
      (b) => b.moveNode("p1", ROOT_ID, 2),
      (b) => void (tail = b.split("r1", 5)),
      (b) => b.textInsert(tail, 0, "|"),
      (b) => void (wrapper = wrapText(b, "r1", 3, 5, { tag: "em" })),
      (b) => unwrap(b, wrapper),
    );
    expect(mapped(node, mapping)).toEqual(node);
    expect(table.get(ROOT_ID)?.children).toEqual(["p2", "p1"]);
    const occ = mapped(occurrence, mapping);
    expect(occ).toMatchObject({ index: 3 });
    expect(anchoredContent(table, occ)).toBe('"b"');
    const caret = mapped(point, mapping);
    expect(anchoredContent(table, caret)).toBe("");
    // Original "hello" survives across the wrap/split structure as several segments, never including "|".
    const segments = mapped(range, mapping);
    expect(anchoredContent(table, segments)?.split("\u0000").join("")).toBe("hello");
    expect(segments.kind === "range" && segments.segments.length).toBeGreaterThan(1);
    // A text insertion inside the range is excluded from the original-content range.
    const inside = mapped(
      range,
      build(doc(), "replica-b", 1, (b) => b.textInsert("r1", 2, "XX")),
    );
    expect(inside).toEqual({
      kind: "range",
      segments: [
        { node: "r1", from: 0, to: 2 },
        { node: "r1", from: 4, to: 7 },
      ],
    });
  });

  test("R28 Removed targets are not equal-looking neighbors", () => {
    const base = doc();
    const second = mapAnchor(
      { kind: "occurrence", node: ROOT_ID, path: ["items"], index: 1 },
      build(base, "replica-a", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 1)),
    );
    expect(second.status).toBe("removed");
    const block = mapAnchor(
      { kind: "node", node: "p2" },
      build(base, "replica-a", 1, (b) => b.deleteNode("p2")),
    );
    expect(block.status).toBe("removed");
    const words = mapAnchor(
      { kind: "range", segments: [{ node: "r2", from: 0, to: 5 }] },
      build(base, "replica-a", 1, (b) => b.textDelete("r2", 0, 6)),
    );
    expect(words.status).toBe("removed");
    // A caret inside deleted text maps to the documented deletion boundary instead.
    const caret = mapAnchor(
      { kind: "point", node: "r2", offset: 3, affinity: "after" },
      build(base, "replica-a", 1, (b) => b.textDelete("r2", 1, 6)),
    );
    expect(caret).toEqual({
      status: "mapped",
      anchor: { kind: "point", node: "r2", offset: 1, affinity: "after" },
    });
    // Lost base history is explicit, never a guessed position.
    const auth = Authority.create(DOC, EPOCH, base);
    auth.submit(
      envelope(
        "replica-a",
        1,
        0,
        build(base, "replica-a", 1, (b) => b.textInsert("r1", 0, "x")),
      ),
      { actor: "a" },
    );
    auth.pruneTransitionsThrough(1);
    expect(
      mapAnchorFrom({ kind: "point", node: "r1", offset: 0, affinity: "after" }, 0, auth).status,
    ).toBe("unavailable");
  });

  test("R29 Boundary affinity and proposal freshness", () => {
    const base = tableFrom([
      makeRow(ROOT_ID, "p", {}, null, ["t"], false),
      makeRow("t", TEXT_TAG, { value: "Ёж😀ab" }, ROOT_ID, [], false),
    ]);
    const insertAtThree = build(base, "replica-a", 1, (b) => b.textInsert("t", 3, "X"));
    expect(
      mapped({ kind: "point", node: "t", offset: 3, affinity: "before" }, insertAtThree),
    ).toMatchObject({ offset: 3 });
    expect(
      mapped({ kind: "point", node: "t", offset: 3, affinity: "after" }, insertAtThree),
    ).toMatchObject({ offset: 4 });
    let tail = "";
    const splitAtThree = build(base, "replica-a", 1, (b) => void (tail = b.split("t", 3)));
    expect(
      mapped({ kind: "point", node: "t", offset: 3, affinity: "before" }, splitAtThree),
    ).toMatchObject({ node: "t", offset: 3 });
    expect(
      mapped({ kind: "point", node: "t", offset: 3, affinity: "after" }, splitAtThree),
    ).toMatchObject({ node: tail, offset: 0 });

    // Address survival is not freshness: the node anchor still maps after its content is rewritten,
    // while the read-content precondition captured with it reports invalidation.
    const read: Anchor = { kind: "node", node: ROOT_ID };
    const fingerprint = anchoredContent(base, read);
    const rewrite = build(base, "replica-b", 1, (b) => b.textReplace("t", 3, 5, "cd"));
    const after = applyChanges(base, rewrite);
    expect(mapped(read, rewrite)).toEqual(read);
    expect(anchoredContent(after, read)).not.toBe(fingerprint);
    expect(anchoredContent(applyChanges(base, []), read)).toBe(fingerprint);

    // A = read base, B = proposal, C = current accepted state.
    const parse = (source: string) => {
      const parsed = parseDocument(source, richTextSchema);
      if (!parsed.ok) throw new Error("fixture");
      return parsed.value;
    };
    const a = toTable(parse(`<doc><p id="p1">Pay in 10 days.</p></doc>`), createAllocator());
    const auth = Authority.create(DOC, EPOCH, a);
    const room = diffStep(a, `<doc><p id="p1">Pay in 10 working days.</p></doc>`);
    auth.submit(envelope("replica-h", 1, 0, room), { actor: "human" });
    const c = auth.getTable();
    const proposal = proposeEdit(
      { table: a, revision: 0 },
      parse(`<doc><p id="p1">Pay in 15 days.</p></doc>`).root,
      { replica: "replica-agent", seq: 1 },
    );
    const rebased = rebaseProposal(proposal, auth);
    expect(auth.getTable()).toBe(c); // rebasing does not mutate C
    if (rebased.status !== "rebased") throw new Error(rebased.status);
    auth.submit(envelope("replica-agent", 1, rebased.revision, rebased.changes), {
      actor: "agent",
    });
    expect(
      serializeDocument(
        fromTable(auth.getTable(), richTextSchema.id, richTextSchema.version),
        richTextSchema,
      ),
    ).toBe('<doc><p id="p1">Pay in 15 working days.</p></doc>');
    auth.pruneTransitionsThrough(auth.getRevision());
    expect(rebaseProposal(proposal, auth).status).toBe("contextUnavailable");
  });
});

function diffStep(a: Table, source: string): Change[] {
  const parsed = parseDocument(source, richTextSchema);
  if (!parsed.ok) throw new Error("fixture");
  return proposeEdit({ table: a, revision: 0 }, parsed.value.root, { replica: "replica-h", seq: 1 })
    .changes as Change[];
}
