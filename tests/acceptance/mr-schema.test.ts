import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import { ChangeBuilder } from "../../src/core/builder.ts";
import type { Change } from "../../src/core/change.ts";
import { DiagnosticError } from "../../src/core/diagnostics.ts";
import {
  decodeDocumentJson,
  normalizeDocument,
  validateDocument,
} from "../../src/core/document-check.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { normalizeComponentProps } from "../../src/core/normalize.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { exportDocument } from "../../src/core/provider-export.ts";
import { decodeProviderOutput } from "../../src/core/provider-decode.ts";
import { encodeProviderOutput } from "../../src/core/provider-encode.ts";
import { proposeEdit, rebaseProposal } from "../../src/core/proposal.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import { migrateLegacySchema, registerSchema } from "../../src/core/schema-legacy.ts";
import type { LegacySchemaProfile } from "../../src/core/schema-legacy.ts";
import type { DocumentSchemaDefinition } from "../../src/core/schema-definition.ts";
import { createAllocator, fromTable, ROOT_ID, toTable } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import type { ComponentNode, DocumentModel, JsonObject, JsonValue } from "../../src/core/types.ts";
import { CATALOG_SOURCE, catalogDefinition, catalogSchema } from "../support/catalog-schema.ts";
import { differential } from "../support/schema-differential.ts";
import { envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";

function model(source = CATALOG_SOURCE): DocumentModel {
  const parsed = parseDocument(source, catalogSchema);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

const table = (m: DocumentModel = model()): Table => toTable(m, createAllocator());
const codes = (diagnostics: readonly { code: string }[]): string[] =>
  diagnostics.map((d) => d.code);
const paths = (diagnostics: readonly { path: string }[]): string[] =>
  diagnostics.map((d) => d.path);
const rootProps = (props: JsonObject) =>
  normalizeComponentProps(catalogSchema, "catalog", props, "$");

function withRoot(props: JsonObject): ComponentNode {
  return { ...model().root, props: { ...model().root.props, ...props } };
}

describe("MR01–MR07 schema contract, validation, and bounded input", () => {
  test("MR01 Standard schema input, legacy migration, and capability diagnostics", () => {
    // The same small domain through the standard manifest and through the legacy importer.
    const legacy: LegacySchemaProfile = {
      id: "legacy.catalog",
      version: "1",
      rootTag: "group",
      unknownPolicy: "error",
      components: {
        group: {
          tag: "group",
          identity: "stable",
          properties: { name: { type: "string", required: true } },
          content: { mode: "element", allowedTags: ["group"] },
        },
      },
    };
    const standard: DocumentSchemaDefinition = {
      id: "legacy.catalog",
      version: "1",
      rootTag: "group",
      components: {
        group: {
          identity: "stable",
          content: { mode: "element", allowedTags: ["group"] },
          props: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
    };
    expect(migrateLegacySchema(legacy)).toMatchObject(standard);
    const [fromLegacy, fromStandard] = [registerSchema(legacy), defineDocumentSchema(standard)];
    expect(fromLegacy.components).toEqual(fromStandard.components);
    for (const props of [{ name: "x" }, {}, { name: 3 }, { name: "x", extra: 1 }])
      expect(codes(normalizeComponentProps(fromLegacy, "group", props, "$").diagnostics)).toEqual(
        codes(normalizeComponentProps(fromStandard, "group", props, "$").diagnostics),
      );
    // Standard required syntax, enum/const, oneOf variants, local $refs, and recursive components.
    expect(codes(rootProps({}).diagnostics)).toEqual(["missingRequired"]);
    expect(codes(rootProps({ title: "t", mode: "other" }).diagnostics)).toEqual(["invalidValue"]);
    expect(codes(rootProps({ title: "t", kind: "other" }).diagnostics)).toEqual(["invalidValue"]);
    expect(rootProps({ title: "t", shape: { r: 1 } }).diagnostics).toEqual([]);
    expect(codes(rootProps({ title: "t", shape: { r: 1, w: 2 } }).diagnostics)).toEqual([
      "invalidValue",
    ]);
    expect(codes(rootProps({ title: "t", rows: [{ qty: 1 }] }).diagnostics)).toEqual([
      "missingRequired",
    ]);
    expect(validateDocument(model().root, catalogSchema)).toEqual([]);
    // Unsupported assertions produce a capability diagnostic at registration.
    for (const keyword of ["patternProperties", "if", "not", "dependentRequired", "format"]) {
      const bad: DocumentSchemaDefinition = {
        ...catalogDefinition,
        components: {
          ...catalogDefinition.components,
          item: {
            identity: "stable",
            content: { mode: "mixed" },
            props: { type: "object", [keyword]: {} },
          },
        },
      };
      let thrown: unknown;
      try {
        defineDocumentSchema(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof DiagnosticError && codes(thrown.diagnostics)).toEqual([
        "capabilityUnsupported",
      ]);
    }
  });

  test("MR02 Recursive validation of containers names the real path", () => {
    const invalid: [JsonObject, string][] = [
      [{ tags: [42] }, "$.tags[0]"],
      [{ tags: ["a", "b", "c", "d"] }, "$.tags"],
      [{ rows: [] }, "$.rows"],
      [{ rows: [{ name: "a", qty: -1 }] }, "$.rows[0].qty"],
      [{ rows: [{ name: "a" }, { name: "" }] }, "$.rows[1].name"],
      [{ limits: { low: "1" } }, "$.limits.low"],
      [{ limits: { band: { width: 11 } } }, "$.limits.band.width"],
      [{ limits: { band: { width: Number.POSITIVE_INFINITY } } }, "$.limits.band.width"],
      [{ limits: { low: 1.5 } }, "$.limits.low"],
    ];
    for (const [props, path] of invalid) {
      const result = rootProps({ title: "t", ...props });
      expect({ props, paths: paths(result.diagnostics) }).toEqual({ props, paths: [path] });
    }
    // Valid counterparts, including duplicate primitive values and more than one nesting level.
    const valid = rootProps({
      title: "t",
      tags: ["a", "a", "b"],
      rows: [
        { name: "a", qty: 0 },
        { name: "a", qty: 0 },
      ],
      limits: { low: 0, band: { width: 10 } },
    });
    expect(valid.diagnostics).toEqual([]);
    expect(valid.value["rows"]).toEqual([
      { name: "a", qty: 0 },
      { name: "a", qty: 0 },
    ]);
  });

  test("MR03 Entry-point equivalence and final-candidate validation", () => {
    const good = model();
    const bad = withRoot({ rows: [{ name: "a", qty: -1 }] });
    // Parse, JSON import, standalone validation, and provider decode agree on the verdict.
    const serializedBad = JSON.parse(JSON.stringify({ ...good, root: bad })) as unknown;
    expect(decodeDocumentJson(JSON.parse(JSON.stringify(good)), catalogSchema).ok).toBe(true);
    expect(decodeDocumentJson(serializedBad, catalogSchema).ok).toBe(false);
    expect(validateDocument(bad, catalogSchema).length).toBeGreaterThan(0);
    expect(normalizeDocument(bad, catalogSchema).diagnostics.length).toBeGreaterThan(0);
    const exported = exportDocument(catalogSchema, "gemini", "rowProjection");
    const wire = encodeProviderOutput(exported, good, catalogSchema);
    expect(decodeProviderOutput(exported, wire, catalogSchema).ok).toBe(true);
    const badWire = encodeProviderOutput(exported, { ...good, root: bad }, catalogSchema);
    expect(decodeProviderOutput(exported, badWire, catalogSchema).ok).toBe(false);
    // The schema-backed authority admits only valid final candidates; nothing invalid publishes.
    const authority = Authority.create(DOC, EPOCH, table(good), { schema: catalogSchema });
    const submit = (seq: number, build: (b: ChangeBuilder) => void) => {
      const b = new ChangeBuilder(authority.getTable(), { replica: "replica-v", seq });
      build(b);
      const decision = authority.submit(
        envelope("replica-v", seq, authority.getRevision(), b.changes),
        { actor: "v" },
      );
      return decision.kind === "decided" ? decision.receipt.outcome : decision.kind;
    };
    const before = authority.getTable();
    expect(submit(1, (b) => b.set(ROOT_ID, ["limits", "low"], -3))).toBe("rejected");
    expect(submit(2, (b) => b.set(ROOT_ID, "title", undefined))).toBe("rejected");
    expect(submit(3, (b) => void b.insertNode("g1", 0, { tag: "ref", props: {} }))).toBe(
      "rejected",
    );
    // A move that places a child where its new parent forbids it.
    const refId = [...before.values()].find((row) => row.tag === "ref")?.id ?? "";
    expect(submit(4, (b) => b.moveNode(refId, "g1", 0))).toBe("rejected");
    expect(authority.getTable()).toBe(before);
    // A temporarily invalid intermediate state is fine when the final candidate is valid.
    expect(submit(5, (b) => b.set(ROOT_ID, "title", undefined).set(ROOT_ID, "title", "Back"))).toBe(
      "applied",
    );
    // A proposal that becomes invalid is refused like any request.
    const proposal = proposeEdit(
      { table: authority.getTable(), revision: authority.getRevision() },
      withRoot({ title: "Back", tags: ["a", "b", "c", "d"] }),
      { replica: "replica-p", seq: 1 },
    );
    const rebased = rebaseProposal(proposal, authority);
    if (rebased.status !== "rebased") throw new Error(rebased.status);
    const decision = authority.submit(envelope("replica-p", 1, rebased.revision, rebased.changes), {
      actor: "p",
    });
    expect(decision.kind === "decided" && decision.receipt.outcome).toBe("rejected");
    // Differential: the optimized final validator agrees with full validation on generated edits.
    differential();
  });

  test("MR04 Defaults without hidden corrections", () => {
    const omitted = rootProps({ title: "t" });
    const nulled = rootProps({ title: "t", flag: null, label: null, count: null });
    const explicit = rootProps({ title: "t", flag: false, label: "untitled", count: 0 });
    expect(omitted.value).toEqual(explicit.value);
    expect(nulled.value).toEqual(explicit.value);
    // Zero, false, and the empty string are meaningful values, never "unset".
    expect(rootProps({ title: "", count: 0, flag: false }).value).toMatchObject({
      title: "",
      count: 0,
      flag: false,
    });
    // Invalid types are diagnosed and never replaced by the default.
    const wrong = rootProps({ title: "t", flag: "yes" });
    expect(codes(wrong.diagnostics)).toEqual(["invalidValue"]);
    expect(wrong.value["flag"]).not.toBe(false);
    // Required fields fail regardless of other defaults; null does not satisfy them.
    expect(codes(rootProps({ title: null }).diagnostics)).toEqual(["missingRequired"]);
    // Invalid nested defaults fail registration.
    const badDefault: DocumentSchemaDefinition = {
      ...catalogDefinition,
      $defs: {
        row: { type: "object", properties: { qty: { type: "integer", minimum: 0, default: -1 } } },
      },
    };
    expect(() => defineDocumentSchema(badDefault)).toThrow(DiagnosticError);
    // Validation does not mutate its input; normalization returns a separate value.
    const input: JsonObject = { title: "t", rows: [{ name: "a" }] };
    const snapshot = JSON.stringify(input);
    const normalized = rootProps(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(normalized.value["rows"]).toEqual([{ name: "a", qty: 0 }]);
    validateDocument(withRoot(input), catalogSchema);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("MR05 Unknown properties at every depth, preservation where permitted", () => {
    for (const [props, path] of [
      [{ extra: 1 }, "$.extra"],
      [{ limits: { odd: 1 } }, "$.limits.odd"],
      [{ rows: [{ name: "a", odd: true }] }, "$.rows[0].odd"],
    ] as [JsonObject, string][]) {
      const result = rootProps({ title: "t", ...props });
      expect({ path, diagnostics: result.diagnostics.map((d) => [d.code, d.path]) }).toEqual({
        path,
        diagnostics: [["unknownProperty", path]],
      });
    }
    // An explicitly extensible component preserves every JSON kind through the whole cycle.
    // (A top-level null member is the omitted value by the effective-value rule; nulls inside
    // arrays and extension objects are data.)
    const extension: JsonObject = {
      note: "n",
      s: "x",
      n: 1.5,
      b: false,
      a: [1, "two", null],
      o: { deep: { k: [true], z: null } },
    };
    const source = CATALOG_SOURCE.replace(
      `<ref target="bolt-1"></ref>`,
      `<ref target="bolt-1"></ref><ext><script type="application/json">${JSON.stringify(extension)}</script></ext>`,
    );
    const parsed = model(source);
    const ext = (m: DocumentModel) =>
      (m.root.content ?? []).find((c) => typeof c !== "string" && c.tag === "ext") as ComponentNode;
    expect(ext(parsed).props).toEqual(extension);
    const edited = applyChanges(table(parsed), [
      ...new ChangeBuilder(table(parsed), { replica: "replica-e", seq: 1 }).set(
        ROOT_ID,
        "title",
        "Edited",
      ).changes,
    ]);
    const roundTrip = decodeDocumentJson(
      JSON.parse(JSON.stringify(fromTable(edited, catalogSchema.id, catalogSchema.version))),
      catalogSchema,
    );
    expect(roundTrip.ok && ext(roundTrip.value).props).toEqual(extension);
    // Hostile keys are rejected without prototype pollution, at the top and nested.
    for (const raw of [
      '{"title":"t","__proto__":{"polluted":1}}',
      '{"title":"t","limits":{"constructor":{"prototype":{"x":1}}}}',
    ]) {
      const result = rootProps(JSON.parse(raw) as JsonObject);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    }
  });

  test("MR06 References and global constraints in the final state", () => {
    const base = table();
    const validate = schemaValidator(catalogSchema);
    const edit = (build: (b: ChangeBuilder) => void): { candidate: Table; changes: Change[] } => {
      const b = new ChangeBuilder(base, { replica: "replica-r", seq: 1 });
      build(b);
      return { candidate: b.current(), changes: [...b.changes] };
    };
    const verdict = ({ candidate, changes }: { candidate: Table; changes: Change[] }) =>
      validate(candidate, changes, base);
    // Deleting or changing a definition referenced from an untouched subtree fails.
    expect(verdict(edit((b) => b.deleteNode("i1")))).toContain("reference");
    expect(verdict(edit((b) => b.set("i1", "sku", "bolt-2")))).toContain("reference");
    // A batch that repairs its own intermediate dangling reference succeeds.
    const refRow = [...base.values()].find((row) => row.tag === "ref");
    expect(
      verdict(edit((b) => b.set("i1", "sku", "bolt-2").set(refRow?.id ?? "", "target", "bolt-2"))),
    ).toBeNull();
    // Duplicate definitions, forbidden nesting, and unknown tags are refused consistently.
    expect(
      verdict(
        edit(
          (b) => void b.insertNode("g2", 0, { tag: "item", id: "i2", props: { sku: "bolt-1" } }),
        ),
      ),
    ).not.toBeNull();
    expect(
      verdict(edit((b) => void b.insertNode("g1", 0, { tag: "ref", props: { target: "bolt-1" } }))),
    ).not.toBeNull();
    expect(
      verdict(edit((b) => void b.insertNode(ROOT_ID, 0, { tag: "script", props: {} }))),
    ).not.toBeNull();
    expect(
      verdict(edit((b) => void b.insertNode(ROOT_ID, 0, { tag: "item", props: {} }))),
    ).not.toBeNull();
    // Domain reference identity is not node identity: moving the defining node keeps it valid.
    expect(verdict(edit((b) => b.moveNode("i1", "g1", 0)))).toBeNull();
    // Equal list values are occurrences, not references.
    expect(verdict(edit((b) => b.arrayDelete(ROOT_ID, ["tags"], 1)))).toBeNull();
  });

  test("MR07 Malformed schemas and bounded hostile input", () => {
    // Schemas usually arrive as untyped JSON, so some cases bypass the compile-time types on purpose.
    const broken: [string, DocumentSchemaDefinition][] = [
      [
        "bad descriptor",
        {
          ...catalogDefinition,
          components: {
            ...catalogDefinition.components,
            item: {
              identity: "stable",
              content: { mode: "mixed" },
              props: { type: "object", properties: { x: { type: "strin" } } },
            },
          },
        } as unknown as DocumentSchemaDefinition,
      ],
      [
        "malformed $ref",
        {
          ...catalogDefinition,
          components: {
            ...catalogDefinition.components,
            item: {
              identity: "stable",
              content: { mode: "mixed" },
              props: { type: "object", properties: { x: { $ref: "#/$defs/missing" } } },
            },
          },
        },
      ],
      [
        "remote $ref",
        {
          ...catalogDefinition,
          components: {
            ...catalogDefinition.components,
            item: {
              identity: "stable",
              content: { mode: "mixed" },
              props: { type: "object", properties: { x: { $ref: "https://example.com/s.json" } } },
            },
          },
        },
      ],
      [
        "impossible default",
        {
          ...catalogDefinition,
          components: {
            ...catalogDefinition.components,
            item: {
              identity: "stable",
              content: { mode: "mixed" },
              props: {
                type: "object",
                properties: { x: { type: "string", maxLength: 1, default: "long" } },
              },
            },
          },
        },
      ],
      [
        "excessive limit",
        {
          ...catalogDefinition,
          components: {
            ...catalogDefinition.components,
            item: {
              identity: "stable",
              content: { mode: "mixed" },
              props: {
                type: "object",
                properties: { x: { type: "string", pattern: "a".repeat(300) } },
              },
            },
          },
        },
      ],
      ["missing root component", { ...catalogDefinition, rootTag: "nothing" }],
      [
        "wrong dialect",
        {
          ...catalogDefinition,
          $schema: "http://json-schema.org/draft-04/schema#",
        } as unknown as DocumentSchemaDefinition,
      ],
    ];
    for (const [name, definition] of broken)
      expect({ name, throws: throwsDiagnostic(() => defineDocumentSchema(definition)) }).toEqual({
        name,
        throws: true,
      });
    // Deep and cyclic in-memory inputs fail with diagnostics, not stack exhaustion.
    let deep: JsonValue = "leaf";
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(rootProps({ title: "t", shape: deep }).diagnostics.map((d) => d.code)).toContain(
      "limitExceeded",
    );
    const cyclic: Record<string, unknown> = { title: "t" };
    cyclic["self"] = cyclic;
    const cyclicCodes = codes(
      normalizeComponentProps(catalogSchema, "ext", cyclic, "$").diagnostics,
    );
    expect(cyclicCodes).toContain("cycleDetected");
    let nested = `<item id="leaf">x</item>`;
    for (let i = 0; i < 2000; i += 1) nested = `<group id="n${i}">${nested}</group>`;
    const parsed = parseDocument(`<catalog id="c" title="t">${nested}</catalog>`, catalogSchema);
    expect(parsed.ok).toBe(false);
    // Schema text is data: registering a schema with script-like strings executes nothing.
    const sneaky = {
      ...catalogDefinition,
      components: {
        ...catalogDefinition.components,
        item: {
          identity: "stable" as const,
          content: { mode: "mixed" as const },
          props: {
            type: "object",
            description: "</script><script>globalThis.pwned=1</script>",
            properties: {},
          },
        },
      },
    };
    defineDocumentSchema(sneaky as unknown as DocumentSchemaDefinition);
    expect((globalThis as Record<string, unknown>)["pwned"]).toBeUndefined();
  });
});

function throwsDiagnostic(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof DiagnosticError;
  }
}
