import { describe, expect, test } from "bun:test";
import { ChangeBuilder } from "../../src/core/builder.ts";
import type { Change } from "../../src/core/change.ts";
import type { DocumentSnapshot } from "../../src/core/store.ts";
import { editableCopy } from "../../src/core/json-copy.ts";
import { normalizeComponentProps } from "../../src/core/normalize.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { proposeEdit } from "../../src/core/proposal.ts";
import { ApplyError } from "../../src/core/staging.ts";
import { createAllocator, fromTable, ROOT_ID, toTable } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import type { DocumentModel, JsonObject } from "../../src/core/types.ts";
import { isJsonArray } from "../../src/core/types.ts";
import { CATALOG_SOURCE, catalogSchema } from "../support/catalog-schema.ts";
import { canonicalTable } from "../support/gen.ts";
import { Room } from "../support/room.ts";

function model(): DocumentModel {
  const parsed = parseDocument(CATALOG_SOURCE, catalogSchema);
  if (!parsed.ok) throw new Error("setup");
  return parsed.value;
}

/* eslint-disable @typescript-eslint/no-unsafe-call -- the calls below are deliberate compile errors */
/**
 * Compile-time contract (MR19): borrowed snapshots, rows, props, nested
 * arrays, and records are read-only in the public types. `tsc` fails the
 * build if any of these writes stops being a type error. The function is
 * never called: it exists only to be type-checked.
 */
function borrowedViewsAreReadOnly(
  snapshot: DocumentSnapshot,
  change: Change,
  m: DocumentModel,
): void {
  const row = snapshot.table.get(ROOT_ID);
  if (row === undefined || change.kind !== "set") return;
  // @ts-expect-error rows are read-only
  row.tag = "x";
  // @ts-expect-error props are read-only
  row.props["title"] = "x";
  // @ts-expect-error child lists are read-only
  row.children.push("x");
  const rows = row.props["rows"];
  // Narrow with `isJsonArray`: TypeScript's `Array.isArray` widens a readonly array to any[].
  // @ts-expect-error nested arrays are read-only
  if (isJsonArray(rows)) rows.push(1);
  // @ts-expect-error records are read-only
  change.after = 1;
  // @ts-expect-error document models are read-only
  m.root.props["title"] = "x";
  // @ts-expect-error the snapshot's table is a read-only map
  snapshot.table.set(ROOT_ID, row);
}
/* eslint-enable @typescript-eslint/no-unsafe-call */

describe("MR19–MR21 ownership and isolation", () => {
  test("MR19 Read-only types and the supported mutation boundary", () => {
    expect(typeof borrowedViewsAreReadOnly).toBe("function");
    // Library operations never change an old snapshot and share untouched rows by identity.
    const room = new Room(toTable(model(), createAllocator()));
    const client = room.join("a", "replica-a");
    const before = client.getSnapshot();
    const frozen = canonicalTable(before.table);
    client.transact((b) => b.set(ROOT_ID, "title", "Changed").setTag("i1", "item"));
    client.transact((b) => b.textInsert(before.table.get("i1")?.children[0] ?? "", 0, ">"));
    room.settle();
    const after = client.getSnapshot();
    expect(canonicalTable(before.table)).toBe(frozen);
    expect(after.table.get("g1")).toBe(before.table.get("g1"));
    expect(after.table.get(ROOT_ID)).not.toBe(before.table.get(ROOT_ID));
    // Rows are frozen objects; writing through a cast fails at runtime in strict mode.
    const row = before.table.get("g1") as { tag: string } | undefined;
    expect(() => {
      if (row !== undefined) row.tag = "other";
    }).toThrow(TypeError);
  });

  test("MR20 Input ownership and free-edit copies", () => {
    // Acquisition by deep copy: the caller keeps editing its own objects afterwards.
    const input = model();
    const editable = editableCopy(input);
    const table = toTable(editable, createAllocator());
    editable.root.props["title"] = "mutated";
    const rows = editable.root.props["rows"];
    if (Array.isArray(rows)) rows.push({ name: "late" });
    expect(table.get(ROOT_ID)?.props["title"]).toBe("Parts");
    expect((table.get(ROOT_ID)?.props["rows"] as unknown[]).length).toBe(2);
    // Builder inputs (set values, array values, inserted subtree props) are copied on acquisition.
    const value = { name: "x", qty: 1 };
    const spec = { tag: "item", id: "n1", props: { sku: "n-1" } };
    const builder = new ChangeBuilder(table, { replica: "replica-o", seq: 1 });
    builder.set(ROOT_ID, ["rows", 0], value).arrayInsert(ROOT_ID, ["tags"], 0, [value.name]);
    builder.insertNode("g1", 0, spec);
    value.qty = 99;
    spec.props.sku = "changed";
    const built = builder.current();
    expect(built.get(ROOT_ID)?.props["rows"]).toEqual([
      { name: "x", qty: 1 },
      { name: "bolt", qty: 2 },
    ]);
    expect(built.get("n1")?.props["sku"]).toBe("n-1");
    const record = builder.changes.find((c) => c.kind === "nodeInsert");
    expect(record?.kind === "nodeInsert" && record.subtree.props["sku"]).toBe("n-1");
    // Free agent edits: A and B never alias the same mutable props.
    const a = fromTable(table, catalogSchema.id, catalogSchema.version);
    const b = editableCopy(a);
    b.root.props["title"] = "B";
    const limits = b.root.props["limits"];
    if (limits !== null && typeof limits === "object" && !Array.isArray(limits)) limits["low"] = 7;
    expect(a.root.props["limits"]).toEqual({ low: 1, band: { width: 3 } });
    expect(table.get(ROOT_ID)?.props["limits"]).toEqual({ low: 1, band: { width: 3 } });
    const proposal = proposeEdit({ table, revision: 0 }, b.root, {
      replica: "replica-b",
      seq: 1,
    });
    expect(proposal.changes.map((c) => c.kind)).toEqual(["set", "set"]);
    // Schema-default objects are materialized per result, never shared between documents.
    const one = normalizeComponentProps(
      catalogSchema,
      "catalog",
      { title: "t", rows: [{ name: "a" }] },
      "$",
    ).value;
    const two = normalizeComponentProps(
      catalogSchema,
      "catalog",
      { title: "t", rows: [{ name: "a" }] },
      "$",
    ).value;
    expect(one["rows"]).not.toBe(two["rows"]);
    const [first] = one["rows"] as { qty: number }[];
    if (first !== undefined) first.qty = 5;
    expect((two["rows"] as JsonObject[])[0]).toEqual({ name: "a", qty: 0 });
  });

  test("MR21 Wire, history, and snapshot stability; failed work leaves no trace", () => {
    const room = new Room(toTable(model(), createAllocator()));
    const client = room.join("a", "replica-a");
    const run = client.getSnapshot().table.get("i1")?.children[0] ?? "";
    client.transact((b) => b.textInsert(run, 0, "A"));
    const sent = client.nextRequest();
    const bytes = JSON.stringify(sent);
    // Building later work, rebasing, and acknowledgements never change the sent envelope.
    client.transact((b) => b.textInsert(run, 0, "B").set(ROOT_ID, "title", "T"));
    room.submit("a", sent);
    room.client("a").transact((b) => b.textInsert(run, 1, "C"));
    room.settle();
    expect(JSON.stringify(sent)).toBe(bytes);
    expect(Object.isFrozen(sent)).toBe(true);
    // Accepted records and their inverse payloads are not affected by later client edits.
    const accepted = JSON.stringify(room.authority.transitionsSince(0));
    client.transact((b) => b.textDelete(run, 0, 1));
    expect(JSON.stringify(room.authority.transitionsSince(0))).toBe(accepted);
    // A transaction that fails midway publishes nothing and leaves state and observers intact.
    const snapshot = client.getSnapshot();
    const commits: unknown[] = [];
    client.subscribeCommits((c) => commits.push(c));
    const status = JSON.stringify(client.getStatus());
    expect(() =>
      client.transact((b) => {
        b.set(ROOT_ID, "title", "partial");
        b.textDelete(run, 0, 999);
      }),
    ).toThrow(ApplyError);
    expect(client.getSnapshot()).toBe(snapshot);
    expect(commits).toEqual([]);
    expect(JSON.stringify(client.getStatus())).toBe(status);
    // Bookkeeping after publication (acknowledgements) never alters published content.
    room.settle();
    const published = client.getSnapshot();
    const content = canonicalTable(published.table);
    client.transact((b) => b.set(ROOT_ID, "title", "Again"));
    room.settle();
    expect(canonicalTable(published.table)).toBe(content);
    const table: Table = client.getSnapshot().table;
    expect(table.get(ROOT_ID)?.props["title"]).toBe("Again");
  });
});
