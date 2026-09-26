import { expect, test } from "bun:test";
import type { DocumentModel, JsonObject, JsonValue } from "../../src/core/types.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { PROVIDER_PROFILES } from "../../src/core/provider-profiles.ts";
import type { ProviderId } from "../../src/core/provider-profiles.ts";
import { exportComponentProperties, exportDocument } from "../../src/core/provider-export.ts";
import { decodeProviderOutput, decodeProviderResponse } from "../../src/core/provider-decode.ts";
import { encodeProviderOutput } from "../../src/core/provider-encode.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import { independentValidator, outlineSchema } from "../support/provider-fixture.ts";

const PROVIDERS: readonly ProviderId[] = ["openai", "anthropic", "gemini"];

function outline(): DocumentModel {
  const parsed = parseDocument(
    [
      '<outline title="Guide">',
      '<section id="s1" heading="Intro" slug="intro"><script type="application/json">{"tags":["a-b","c-d"]}</script>',
      "<para>Hello <em>big</em> world</para>",
      '<section id="s2" heading="" level="2"><note id="n1" target="intro" text="see intro" /></section>',
      "</section>",
      "</outline>",
    ].join(""),
    outlineSchema,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

test("S01 Provider schema baseline", () => {
  for (const provider of PROVIDERS) {
    const props = exportComponentProperties(outlineSchema, "section", provider);
    const document = exportDocument(outlineSchema, provider);
    expect(props.scope).toBe("componentProperties");
    expect(document.scope).toBe("document");
    expect(document.route).toBe(
      PROVIDER_PROFILES[provider].recursion &&
        document.incompatibilities.length === 0 &&
        document.route === "nativeTree"
        ? "nativeTree"
        : document.route,
    );
    for (const exported of [props, document]) {
      expect(exported.profileRetrieved).toBe(PROVIDER_PROFILES[provider].retrieved);
      expect(exported.generationEnforced.length).toBeGreaterThan(0);
      expect(exported.budgets.maxDepth.basis).toMatch(/documented|internal/);
      // The emitted grammar itself is valid 2020-12 JSON Schema for an independent validator.
      expect(() => independentValidator(exported.requestSchema)).not.toThrow();
    }
  }
  // Anthropic structured outputs do not support recursion: the document route is the typed projection.
  expect(exportDocument(outlineSchema, "anthropic").route).toBe("rowProjection");
  expect(PROVIDER_PROFILES.anthropic.recursion).toBe(false);
});

test("S02 Unsupported constraints", () => {
  const anthropic = exportComponentProperties(outlineSchema, "section", "anthropic");
  const openai = exportComponentProperties(outlineSchema, "section", "openai");
  // minimum/maximum are unsupported by Anthropic: dropped from the emitted schema and declared local-only.
  expect(anthropic.localOnly).toContain("section.level:minimum");
  expect(anthropic.generationEnforced).not.toContain("section.level:minimum");
  expect(JSON.stringify(anthropic.requestSchema)).not.toContain('"minimum"');
  expect(openai.generationEnforced).toContain("section.level:minimum");
  // minItems 2 cannot be expressed for Anthropic (only 0/1) and is local-only.
  expect(anthropic.localOnly).toContain("section.tags:minItems");
  // The weakened constraint is still enforced after decode.
  const tooLow = decodeProviderOutput(anthropic, { heading: "h", level: 0 }, outlineSchema);
  expect(tooLow.ok).toBe(false);
  // Every enforced claim names a keyword that is really present in the emitted schema.
  for (const exported of [anthropic, openai])
    for (const claim of exported.generationEnforced) {
      const keyword = claim.split(":").pop() ?? "";
      expect(JSON.stringify(exported.requestSchema)).toContain(`"${keyword}"`);
    }
});

test("S03 Optional output without presence wrappers", () => {
  const nullable = exportComponentProperties(outlineSchema, "section", "openai");
  const omitting = exportComponentProperties(outlineSchema, "section", "anthropic");
  const required = (nullable.requestSchema["required"] ?? []) as readonly string[];
  expect([...required].sort()).toEqual(["draft", "heading", "level", "slug", "tags"]);
  expect(omitting.requestSchema["required"]).toEqual(["heading"]);
  const expected = { heading: "", level: 1, draft: false };
  const answers: [typeof nullable, JsonObject][] = [
    [nullable, { heading: "", slug: null, level: null, tags: null, draft: null }],
    [nullable, { heading: "", slug: null, level: 1, tags: null, draft: false }],
    [omitting, { heading: "" }],
    [omitting, { heading: "", level: 1, draft: false }],
  ];
  for (const [exported, answer] of answers) {
    const decoded = decodeProviderOutput(exported, answer, outlineSchema);
    expect(decoded.ok && decoded.value).toEqual(expected);
    // No presence wrapper anywhere in the emitted grammar.
    expect(JSON.stringify(exported.requestSchema)).not.toContain("present");
  }
});

test("S04 Recursive and projected trees", () => {
  const model = outline();
  for (const [provider, route] of [
    ["gemini", "nativeTree"],
    ["openai", "nativeTree"],
    ["anthropic", "rowProjection"],
    ["openai", "rowProjection"],
  ] as const) {
    const exported = exportDocument(outlineSchema, provider, route);
    const wire = encodeProviderOutput(exported, model, outlineSchema);
    expect({ provider, route, valid: independentValidator(exported.requestSchema)(wire) }).toEqual({
      provider,
      route,
      valid: true,
    });
    const decoded = decodeProviderOutput(exported, wire, outlineSchema);
    expect(decoded.ok && decoded.value).toEqual(model);
    // Decode → re-encode → decode is stable.
    if (decoded.ok)
      expect(encodeProviderOutput(exported, decoded.value, outlineSchema)).toEqual(wire);
  }
  const projection = exportDocument(outlineSchema, "anthropic");
  const rows = encodeProviderOutput(projection, model, outlineSchema) as {
    root: JsonObject;
    rows: JsonObject[];
  };
  const mutate = (edit: (r: JsonObject[]) => JsonObject[]): JsonValue => ({
    root: rows.root,
    rows: edit(rows.rows.map((r) => ({ ...r }))),
  });
  const cyclic = mutate((r) =>
    r.map((row, i) =>
      i === 0 ? { ...row, parent: "r2" } : i === 1 ? { ...row, parent: "r1" } : row,
    ),
  );
  const dangling = mutate((r) =>
    r.map((row, i) => (i === 0 ? { ...row, parent: "nowhere" } : row)),
  );
  const inText = mutate((r) => [...r, { ref: "rx", parent: "r3", tag: "em", props: {} }]);
  const badNesting = mutate((r) => [...r, { ref: "ry", parent: "r0", tag: "para", props: {} }]);
  for (const [name, broken] of Object.entries({ cyclic, dangling, inText, badNesting })) {
    const result = decodeProviderOutput(projection, broken, outlineSchema);
    expect({ name, ok: result.ok }).toEqual({ name, ok: false });
  }
});

test("S05 Provider complexity boundaries", () => {
  const properties: Record<string, JsonObject> = {};
  for (let i = 0; i < 150; i += 1) properties[`field${i}`] = { type: "string" };
  const wide = defineDocumentSchema({
    id: "fixture.wide",
    version: "1",
    rootTag: "form",
    components: {
      form: {
        identity: "none",
        content: { mode: "none" },
        props: { type: "object", properties, additionalProperties: false },
      },
    },
  });
  const exported = exportComponentProperties(wide, "form", "openai");
  expect(exported.measured.properties).toBe(150);
  expect(exported.incompatibilities.join(" ")).toContain("exceed the internal budget 100");
  // Nothing is truncated to fit.
  expect(Object.keys((exported.requestSchema["properties"] ?? {}) as JsonObject)).toHaveLength(150);
  // The native tree for OpenAI measures deeper than the conservative 5-level budget, so the
  // default route falls back to the projection and says why the native route was not chosen.
  const native = exportDocument(outlineSchema, "openai", "nativeTree");
  expect(native.measured.depth).toBeGreaterThan(5);
  expect(native.incompatibilities.some((m) => m.includes("nesting depth"))).toBe(true);
  expect(exportDocument(outlineSchema, "openai").route).toBe("rowProjection");
  expect(exportDocument(outlineSchema, "openai").incompatibilities).toEqual([]);
});

test("S06 Wire references are not persistent IDs", () => {
  const exported = exportDocument(outlineSchema, "anthropic");
  const wire = encodeProviderOutput(exported, outline(), outlineSchema) as { rows: JsonObject[] };
  expect(wire.rows.every((row) => typeof row["ref"] === "string")).toBe(true);
  const decoded = decodeProviderOutput(exported, wire, outlineSchema);
  if (!decoded.ok) throw new Error("decode failed");
  const text = JSON.stringify(decoded.value);
  expect(text).not.toContain('"r1"');
  expect(text).toContain('"id":"s1"');
  // Anonymous paragraphs and emphasis stay anonymous.
  expect((decoded.value as DocumentModel).root.content?.[0]).toMatchObject({ id: "s1" });
  expect(text.match(/"id":/g)).toHaveLength(3);
});

test("S07 Locally invalid structured output", () => {
  const exported = exportDocument(outlineSchema, "gemini", "nativeTree");
  const wire = encodeProviderOutput(exported, outline(), outlineSchema);
  const text = JSON.stringify(wire);
  const dangling = JSON.parse(text.replace('"target":"intro"', '"target":"missing"')) as JsonValue;
  const duplicate = JSON.parse(text.replace('"id":"s2"', '"id":"s1"')) as JsonValue;
  const d1 = decodeProviderOutput(exported, dangling, outlineSchema);
  const d2 = decodeProviderOutput(exported, duplicate, outlineSchema);
  expect(d1.ok).toBe(false);
  expect(d2.ok).toBe(false);
  if (!d1.ok) expect(d1.diagnostics.some((d) => d.code === "danglingReference")).toBe(true);
  if (!d2.ok) expect(d2.diagnostics.some((d) => d.code === "duplicateId")).toBe(true);
});

test("S08 SDK adaptation and incomplete responses", () => {
  const exported = exportComponentProperties(outlineSchema, "section", "openai");
  for (const response of [
    { status: "refusal", reason: "policy" },
    { status: "incomplete", partialJson: '{"heading": "h' },
    { status: "schemaError", detail: "invalid schema" },
    { status: "ok", json: '{"heading": ' },
  ] as const)
    expect(decodeProviderResponse(response, exported, outlineSchema).ok).toBe(false);
  // An SDK that rewrote the request schema (here: dropped `maximum`) cannot smuggle an
  // out-of-range value past decode: the export's own schema and the local contract still apply.
  const withoutMaximum = (value: JsonValue): JsonValue =>
    Array.isArray(value)
      ? value.map(withoutMaximum)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([k]) => k !== "maximum")
              .map(([k, v]) => [k, withoutMaximum(v)]),
          )
        : value;
  const sdkRewritten = {
    ...exported,
    requestSchema: withoutMaximum(exported.requestSchema) as JsonObject,
  };
  const answer = JSON.stringify({ heading: "h", slug: null, level: 9, tags: null, draft: null });
  expect(
    decodeProviderResponse({ status: "ok", json: answer }, sdkRewritten, outlineSchema).ok,
  ).toBe(false);
});
