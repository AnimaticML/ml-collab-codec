import { describe, expect, test } from "bun:test";
import { ChangeBuilder } from "../../src/core/builder.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { exportCheckpoint, importCheckpoint } from "../../src/core/checkpoint.ts";
import { decodeDocumentJson } from "../../src/core/document-check.ts";
import { Authority } from "../../src/core/authority.ts";
import { parseDocument, parseFragment, parseMultiRoot } from "../../src/core/parser.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import { SnapshotError } from "../../src/core/snapshot-rows.ts";
import { createAllocator, fromTable, ROOT_ID, toTable } from "../../src/core/table.ts";
import type { ComponentNode, DocumentModel } from "../../src/core/types.ts";
import { CATALOG_SOURCE, catalogDefinition, catalogSchema } from "../support/catalog-schema.ts";
import { DOC, EPOCH } from "../support/room.ts";

const opaque = defineDocumentSchema({
  ...catalogDefinition,
  id: "fixture.catalog-open",
  unknownComponents: "preserve",
});

function parse(source: string, schema = catalogSchema): DocumentModel {
  const parsed = parseDocument(source, schema);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

function findTag(node: ComponentNode, tag: string): ComponentNode | undefined {
  if (node.tag === tag) return node;
  for (const child of node.content ?? [])
    if (typeof child !== "string") {
      const found = findTag(child, tag);
      if (found !== undefined) return found;
    }
  return undefined;
}

/** parse(print(m)) ≡ m, reprinting is stable, and the saved JSON reopens to the same model. */
function roundTrips(m: DocumentModel, schema = catalogSchema): void {
  const printed = serializeDocument(m, schema);
  const reparsed = parse(printed, schema);
  expect(reparsed).toEqual(m);
  expect(serializeDocument(reparsed, schema)).toBe(printed);
  const saved = decodeDocumentJson(JSON.parse(JSON.stringify(m)), schema);
  expect(saved.ok && saved.value).toEqual(m);
}

describe("MR08–MR10 lossless codec, root/fragment honesty, and root identity", () => {
  test("MR08 Complete opaque and mixed-content round-trip", () => {
    // Known component with permitted extra props of every JSON kind.
    const ext = {
      note: "n",
      s: "a<b>&\"'",
      n: -0.5,
      b: true,
      list: [1, "x", null, { k: [] }],
      o: { deep: { e: {} } },
    };
    const withExt = CATALOG_SOURCE.replace(
      "</catalog>",
      `<ext><script type="application/json">${JSON.stringify(ext)}</script></ext></catalog>`,
    );
    roundTrips(parse(withExt));
    // Unknown opaque components keep structured JSON and scalar attribute values.
    // (Placed inside a mixed item: explicit allowedTags lists still govern nesting.)
    const unknown = CATALOG_SOURCE.replace(
      "Bolt</item>",
      `Bolt <widget size="3" on="true" label="x"><script type="application/json">{"data":{"rows":[1,2]},"z":[null]}</script>inner <b>bold</b></widget></item>`,
    );
    const opened = parse(unknown, opaque);
    const widget = findTag(opened.root, "widget");
    expect(widget?.props).toMatchObject({ data: { rows: [1, 2] }, z: [null] });
    roundTrips(opened, opaque);
    // Mixed text: significant whitespace, entities, astral characters, and combining marks survive.
    const mixed = CATALOG_SOURCE.replace(
      `<item id="i1" sku="bolt-1">Bolt</item>`,
      `<item id="i1" sku="bolt-1">  lead &amp; &lt;tag&gt; 😀 é  <group id="x1"></group>  tail  </item>`,
    );
    roundTrips(parse(mixed));
    // A value the format cannot represent is rejected before a successful save, never omitted.
    const unsupported: DocumentModel = {
      ...parse(withExt),
      root: {
        ...parse(withExt).root,
        props: { ...parse(withExt).root.props, title: Number.NaN },
      },
    };
    expect(() => serializeDocument(unsupported, catalogSchema)).toThrow();
    expect(
      decodeDocumentJson(JSON.parse(JSON.stringify({ ...unsupported })), catalogSchema).ok,
    ).toBe(false);
  });

  test("MR09 Root and fragment API honesty", () => {
    expect(parseDocument("", catalogSchema).ok).toBe(false);
    expect(parseDocument("   ", catalogSchema).ok).toBe(false);
    expect(parseDocument(`${CATALOG_SOURCE}${CATALOG_SOURCE}`, catalogSchema).ok).toBe(false);
    expect(parseDocument(`text ${CATALOG_SOURCE}`, catalogSchema).ok).toBe(false);
    expect(parseDocument(CATALOG_SOURCE, catalogSchema).ok).toBe(true);
    const roots = parseMultiRoot(
      `<item id="a">1</item>\n<item id="b">2</item><item id="c">3</item>`,
      catalogSchema,
    );
    expect(roots.ok && roots.value.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(parseMultiRoot(`<item id="a">1</item> stray text`, catalogSchema).ok).toBe(false);
    // Zero roots is reported, not returned as an empty success.
    expect(parseMultiRoot("", catalogSchema).ok).toBe(false);
    const fragment = parseFragment(`lead <item id="a">1</item> tail`, catalogSchema);
    expect(fragment.ok && fragment.value).toEqual([
      "lead ",
      expect.objectContaining({ id: "a" }),
      " tail",
    ]);
    // Failures report diagnostics and leave the caller's source untouched.
    const source = `<catalog title="t"><item id="a"></item><item id="a"></item></catalog>`;
    const copy = String(source);
    const failed = parseDocument(source, catalogSchema);
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.some((d) => d.code === "duplicateId")).toBe(true);
    expect(source).toBe(copy);
  });

  test("MR10 Root identity and interpretation metadata", () => {
    const m = parse(CATALOG_SOURCE);
    expect(m.root.id).toBe("c1");
    // model → table → operations → model → source → JSON keeps the persisted root id.
    const table = toTable(m, createAllocator());
    expect(table.get(ROOT_ID)?.rootId).toBe("c1");
    const edited = applyChanges(table, [
      ...new ChangeBuilder(table, { replica: "replica-r", seq: 1 }).set(ROOT_ID, "title", "New")
        .changes,
    ]);
    const back = fromTable(edited, catalogSchema.id, catalogSchema.version);
    expect(back.root.id).toBe("c1");
    expect(parse(serializeDocument(back, catalogSchema)).root.id).toBe("c1");
    const json = decodeDocumentJson(JSON.parse(JSON.stringify(back)), catalogSchema);
    expect(json.ok && json.value.root.id).toBe("c1");
    // Ids that look like internal handles are ordinary persisted ids, never confused with handles.
    const tricky = parse(
      `<catalog id="t0" title="x"><item id="t1">a</item><item id="replica-a~1.1">b</item></catalog>`,
    );
    const trickyTable = toTable(tricky, createAllocator());
    expect(fromTable(trickyTable, catalogSchema.id, catalogSchema.version)).toEqual(tricky);
    expect(parseDocument(`<catalog id="$root" title="x"></catalog>`, catalogSchema).ok).toBe(false);
    // Standalone copies are independent documents with the same interpretation metadata.
    const copy = decodeDocumentJson(JSON.parse(JSON.stringify(m)), catalogSchema);
    expect(copy.ok && [copy.value.schemaId, copy.value.schemaVersion]).toEqual([
      catalogSchema.id,
      catalogSchema.version,
    ]);
    // A different schema id or version is refused, for documents and checkpoints alike.
    expect(
      decodeDocumentJson(
        { ...JSON.parse(JSON.stringify(m)), schemaVersion: "2.0.0" },
        catalogSchema,
      ).ok,
    ).toBe(false);
    expect(
      decodeDocumentJson({ ...JSON.parse(JSON.stringify(m)), schemaId: "other" }, catalogSchema).ok,
    ).toBe(false);
    const bundle = exportCheckpoint(Authority.create(DOC, EPOCH, table), catalogSchema);
    expect(importCheckpoint(bundle, catalogSchema).table.get(ROOT_ID)?.rootId).toBe("c1");
    expect(() => importCheckpoint(bundle, { id: catalogSchema.id, version: "2.0.0" })).toThrow(
      SnapshotError,
    );
  });
});
