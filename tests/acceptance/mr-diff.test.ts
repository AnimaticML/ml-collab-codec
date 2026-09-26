import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { invertChanges, subtreeIds } from "../../src/core/change.ts";
import type { Change } from "../../src/core/change.ts";
import { canonicalJson, decodeChanges } from "../../src/core/change-codec.ts";
import { diffToChanges } from "../../src/core/diff.ts";
import { textHunks } from "../../src/core/diff-text.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { proposeEdit, rebaseProposal } from "../../src/core/proposal.ts";
import type { TransitionSource } from "../../src/core/proposal.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import { ApplyError } from "../../src/core/staging.ts";
import { createAllocator, fromTable, ROOT_ID, toTable } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { isConflict, rebase } from "../../src/core/transform.ts";
import type { ComponentNode } from "../../src/core/types.ts";
import { validateTable } from "../../src/core/validate.ts";
import { mutateModel, randomModel, reorderKeys } from "../support/model-gen.ts";
import { rng, seedBudget } from "../support/random.ts";
import { build } from "../support/requests.ts";

const blockProps = {
  type: "object",
  properties: { slug: { type: "string", "x-reference": "definition" } },
  additionalProperties: false,
} as const;
const schema = defineDocumentSchema({
  id: "mr.diff",
  version: "1",
  rootTag: "doc",
  components: {
    doc: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["p", "h", "ref", "sec"] },
      props: { type: "object", properties: { title: { type: "string" } } },
    },
    sec: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["p", "h"] },
      props: { type: "object", properties: {} },
    },
    p: { identity: "stable", content: { mode: "mixed" }, props: blockProps },
    h: { identity: "stable", content: { mode: "mixed" }, props: blockProps },
    ref: {
      identity: "none",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { target: { type: "string", "x-reference": "reference" } },
        required: ["target"],
      },
    },
  },
});

function load(source: string): Table {
  const parsed = parseDocument(source, schema);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return toTable(parsed.value, createAllocator());
}

function root(source: string): ComponentNode {
  const parsed = parseDocument(source, schema);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value.root;
}

const model = (table: Table): unknown => fromTable(table, "x", "1");
const author = { replica: "replica-d", seq: 1 };

/** A → C history for proposals: the transitions a user committed after the agent read A. */
function history(...transitions: (readonly Change[])[]): TransitionSource {
  return {
    getRevision: () => transitions.length,
    transitionsSince: (revision) => transitions.slice(revision).map((changes) => ({ changes })),
  };
}

describe("MR11–MR13 identity-aware diff", () => {
  test("MR11 Same-ID node type change keeps identity, content, and references", () => {
    const base = load(
      `<doc id="d1"><p id="p1" slug="intro">Hello</p><ref target="intro"></ref></doc>`,
    );
    // Identical text/props: exactly one in-place retag, no delete/recreate, no fresh id.
    const same = root(
      `<doc id="d1"><h id="p1" slug="intro">Hello</h><ref target="intro"></ref></doc>`,
    );
    const retag = diffToChanges(base, same, author);
    expect(retag.map((c) => c.kind)).toEqual(["setTag"]);
    const applied = applyChanges(base, retag);
    expect(model(applied)).toEqual(
      model(load(`<doc id="d1"><h id="p1" slug="intro">Hello</h><ref target="intro"></ref></doc>`)),
    );
    expect(applied.get("p1")?.tag).toBe("h");
    expect(validateTable(applied, schema)).toEqual([]);
    // Changed content as well: retag plus a local text edit.
    const changed = root(
      `<doc id="d1"><h id="p1" slug="intro">Hello there</h><ref target="intro"></ref></doc>`,
    );
    const both = diffToChanges(base, changed, author);
    expect(both.map((c) => c.kind)).toEqual(["setTag", "textInsert"]);
    expect(model(applyChanges(base, both))).toEqual(
      model(
        load(
          `<doc id="d1"><h id="p1" slug="intro">Hello there</h><ref target="intro"></ref></doc>`,
        ),
      ),
    );
    // Nested retag inside a container, and the root's own type/id metadata.
    const nested = load(`<doc id="d1"><sec id="s1"><p id="p2">x</p></sec></doc>`);
    const nestedTarget = root(`<doc id="d1"><sec id="s1"><h id="p2">x</h></sec></doc>`);
    expect(diffToChanges(nested, nestedTarget, author).map((c) => c.kind)).toEqual(["setTag"]);
    expect(model(applyChanges(nested, diffToChanges(nested, nestedTarget, author)))).toEqual(
      model(load(`<doc id="d1"><sec id="s1"><h id="p2">x</h></sec></doc>`)),
    );
    const rootRetag = diffToChanges(base, { ...same, tag: "sec" }, author);
    expect(rootRetag.filter((c) => c.kind === "setTag").map((c) => c.node)).toEqual([
      ROOT_ID,
      "p1",
    ]);
    expect(() => diffToChanges(base, { ...same, id: "other" }, author)).toThrow(ApplyError);
    expect(() => diffToChanges(base, { tag: same.tag, props: same.props }, author)).toThrow(
      "root identity cannot change",
    );
    // Inverse and wire form: the record carries before/after and round-trips losslessly.
    const inverse = invertChanges(retag);
    expect(model(applyChanges(applied, inverse))).toEqual(model(base));
    const wire = JSON.parse(canonicalJson(retag)) as unknown;
    expect(decodeChanges(wire)).toEqual(retag);
    // Generic concurrent policy: equal retags agree, different retags conflict, retag commutes
    // with edits inside the node, and a retag of a concurrently deleted node conflicts (the
    // general policy for any write whose target was deleted).
    const toHeading = build(base, "replica-a", 1, (b) => b.setTag("p1", "h"));
    const toSection = build(base, "replica-b", 1, (b) => b.setTag("p1", "sec"));
    expect(rebase(toHeading, toHeading)).toEqual([]);
    expect(isConflict(rebase(toSection, toHeading))).toBe(true);
    const run = base.get("p1")?.children[0] ?? "";
    const typed = build(base, "replica-c", 1, (b) => b.textInsert(run, 5, "!"));
    const rebased = rebase(toHeading, typed);
    if (isConflict(rebased)) throw new Error("unexpected conflict");
    const merged = applyChanges(applyChanges(base, typed), rebased);
    expect([merged.get("p1")?.tag, merged.get(run)?.props["value"]]).toEqual(["h", "Hello!"]);
    const removed = build(base, "replica-e", 1, (b) => b.deleteNode("p1"));
    expect(rebase(toHeading, removed)).toMatchObject({ conflict: "deleted" });
  });

  test("MR12 Structural and list diff laws on generated documents", () => {
    for (const seed of seedBudget(400)) {
      const r = rng(seed);
      const a = randomModel(r);
      const b = mutateModel(r, a, 1 + r.int(4));
      const base = toTable({ schemaId: "x", schemaVersion: "1", root: a }, createAllocator());
      const target = model(
        toTable({ schemaId: "x", schemaVersion: "1", root: b }, createAllocator()),
      );
      const changes = diffToChanges(base, b, author);
      const after = applyChanges(base, changes);
      expect({ seed, model: model(after) }).toEqual({ seed, model: target });
      // Persisted identity: an id kept from A to B is never deleted or recreated, only moved.
      const kept = [...base.values()].filter((row) => row.persisted && after.has(row.id));
      const touched = changes.flatMap((change) =>
        change.kind === "nodeDelete" || change.kind === "nodeInsert"
          ? [...subtreeIds(change.subtree)]
          : [],
      );
      expect({ seed, recreated: kept.filter((row) => touched.includes(row.id)) }).toEqual({
        seed,
        recreated: [],
      });
      expect({ seed, model: model(applyChanges(after, invertChanges(changes))) }).toEqual({
        seed,
        model: model(base),
      });
      // Irrelevant object-key order produces the same transition.
      expect({ seed, changes: diffToChanges(base, reorderKeys(b), author) }).toEqual({
        seed,
        changes,
      });
    }
    // Equal list values are occurrences, not interchangeable instances: removing the second
    // "dup" deletes index 2, and a first-occurrence edit stays at index 1.
    const list = toTable(
      {
        schemaId: "x",
        schemaVersion: "1",
        root: { tag: "doc", props: { items: ["a", "dup", "dup", "b"] } },
      },
      createAllocator(),
    );
    const dropped = diffToChanges(
      list,
      { tag: "doc", props: { items: ["a", "dup", "b"] } },
      author,
    );
    expect(dropped).toMatchObject([
      { kind: "arrayDelete", path: ["items"], index: 2, values: ["dup"] },
    ]);
    // Object items at the same positions are edited in place, per field.
    const objects = toTable(
      {
        schemaId: "x",
        schemaVersion: "1",
        root: {
          tag: "doc",
          props: {
            rows: [
              { a: 1, b: 1 },
              { a: 1, b: 1 },
            ],
          },
        },
      },
      createAllocator(),
    );
    const field = diffToChanges(
      objects,
      {
        tag: "doc",
        props: {
          rows: [
            { a: 1, b: 1 },
            { a: 1, b: 2 },
          ],
        },
      },
      author,
    );
    expect(field).toMatchObject([{ kind: "set", path: ["rows", 1, "b"], before: 1, after: 2 }]);
  });

  test("MR13 Granular proposals rebase over independent user work; conflicts keep the proposal", () => {
    const source = `<doc id="d1" title="T"><p id="p1">alpha beta gamma delta epsilon</p><p id="p2">second</p></doc>`;
    const a = load(source);
    // User (A→C): an edit in the middle of p1 and a retitle of the document.
    const userText = build(a, "replica-u", 1, (b) =>
      b.textInsert(a.get("p1")?.children[0] ?? "", 11, "[U]"),
    );
    const userTitle = build(applyChanges(a, userText), "replica-u", 2, (b) =>
      b.set(ROOT_ID, "title", "User"),
    );
    const c = applyChanges(applyChanges(a, userText), userTitle);
    // Agent (A→B): distant edits at both ends of p1 and in p2; title unchanged.
    const agentTarget = root(
      `<doc id="d1" title="T"><p id="p1">ALPHA beta gamma delta EPSILON</p><p id="p2">second!</p></doc>`,
    );
    const proposal = proposeEdit({ table: a, revision: 0 }, agentTarget, author);
    expect(proposal.changes.filter((ch) => ch.kind === "textDelete")).toHaveLength(2);
    const outcome = rebaseProposal(proposal, history(userText, userTitle));
    if (outcome.status !== "rebased") throw new Error(outcome.status);
    expect(model(applyChanges(c, outcome.changes))).toEqual(
      model(
        load(
          `<doc id="d1" title="User"><p id="p1">ALPHA beta [U]gamma delta EPSILON</p><p id="p2">second!</p></doc>`,
        ),
      ),
    );
    // Independent nested props / list regions: agent edits one field, user another.
    const props = toTable(
      {
        schemaId: "x",
        schemaVersion: "1",
        root: { tag: "doc", props: { meta: { a: 1, b: 1 }, list: ["x", "y", "z"] } },
      },
      createAllocator(),
    );
    const user = build(props, "replica-u", 1, (b) =>
      b.set(ROOT_ID, ["meta", "b"], 2).arrayInsert(ROOT_ID, ["list"], 0, ["u"]),
    );
    const agent = proposeEdit(
      { table: props, revision: 0 },
      { tag: "doc", props: { meta: { a: 5, b: 1 }, list: ["x", "y", "z", "w"] } },
      author,
    );
    const merged = rebaseProposal(agent, history(user));
    if (merged.status !== "rebased") throw new Error(merged.status);
    expect(applyChanges(applyChanges(props, user), merged.changes).get(ROOT_ID)?.props).toEqual({
      meta: { a: 5, b: 2 },
      list: ["u", "x", "y", "z", "w"],
    });
    // Coarse boundary: anonymous siblings have positional identity only. Deleting the first of two
    // identical-tag anonymous runs is aligned as "keep the first, drop the last", so concurrent
    // work in the dropped position is lost with it; the applied result still equals B.
    const anon = toTable(
      {
        schemaId: "x",
        schemaVersion: "1",
        root: {
          tag: "doc",
          props: {},
          content: [
            { tag: "em", props: {}, content: ["one"] },
            { tag: "em", props: {}, content: ["two"] },
          ],
        },
      },
      createAllocator(),
    );
    const anonTarget: ComponentNode = {
      tag: "doc",
      props: {},
      content: [{ tag: "em", props: {}, content: ["two"] }],
    };
    const anonChanges = diffToChanges(anon, anonTarget, author);
    expect(anonChanges.map((ch) => ch.kind)).toEqual(["nodeDelete", "textInsert", "textDelete"]);
    expect(model(applyChanges(anon, anonChanges))).toEqual(
      model(toTable({ schemaId: "x", schemaVersion: "1", root: anonTarget }, createAllocator())),
    );
    // A same-field conflict keeps the original proposal intact for review.
    const clash = build(props, "replica-u", 1, (b) => b.set(ROOT_ID, ["meta", "a"], 9));
    const before = canonicalJson(agent);
    const conflicted = rebaseProposal(agent, history(clash));
    expect(conflicted.status).toBe("conflict");
    expect(canonicalJson(agent)).toBe(before);
    // Text hunks stay separate across distant edits (not one wide splice).
    expect(textHunks("one two three", "One two threE")).toEqual([
      { from: 0, to: 1, insert: "O" },
      { from: 12, to: 13, insert: "E" },
    ]);
  });
});
