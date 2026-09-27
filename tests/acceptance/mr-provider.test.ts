import { describe, expect, test } from "bun:test";
import { parseDocument } from "../../src/core/parser.ts";
import { PROVIDER_PROFILES } from "../../src/core/provider-profiles.ts";
import type { ProviderId } from "../../src/core/provider-profiles.ts";
import { exportComponentProperties, exportDocument } from "../../src/core/provider-export.ts";
import type { ProviderExport } from "../../src/core/provider-export.ts";
import { decodeProviderOutput, decodeProviderResponse } from "../../src/core/provider-decode.ts";
import { encodeProviderOutput } from "../../src/core/provider-encode.ts";
import { defineDocumentSchema } from "../../src/core/schema-document.ts";
import type { JsonSchema } from "../../src/core/schema-definition.ts";
import type { DocumentModel, JsonObject, JsonValue } from "../../src/core/types.ts";
import { root } from "../support/built.ts";
import { independentValidator, outlineSchema } from "../support/provider-fixture.ts";

const PROVIDERS: readonly ProviderId[] = ["openai", "anthropic", "gemini"];

function outline(): DocumentModel {
  const parsed = parseDocument(
    [
      '<outline title="Guide">',
      '<section id="s1" heading="Intro" slug="intro"><script type="application/json">{"tags":["a-b","c-d"]}</script>',
      "<para>Lead <em>big <em>nested</em></em> tail</para>",
      '<section id="s2" heading="Deeper" level="3"><para>x</para><note id="n1" target="intro" text="see" /></section>',
      "</section>",
      "</outline>",
    ].join(""),
    outlineSchema,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

/** A one-component schema whose props nest `depth` objects and carry `width` fields and `unions` oneOf fields. */
function sized(depth: number, width: number, unions = 0): ReturnType<typeof defineDocumentSchema> {
  let nested: JsonSchema = { type: "string" };
  for (let i = 0; i < depth; i += 1)
    nested = { type: "object", properties: { next: nested }, additionalProperties: false };
  const properties: Record<string, JsonSchema> = { nested };
  for (let i = 1; i < width; i += 1) properties[`f${i}`] = { type: "string" };
  for (let i = 0; i < unions; i += 1)
    properties[`u${i}`] = { oneOf: [{ type: "string" }, { type: "number" }] };
  return defineDocumentSchema({
    id: `fixture.sized.${depth}.${width}.${unions}`,
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
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number; out: string } {
  const result = Bun.spawnSync(args, {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe("MR14–MR18 provider exports, projections, budgets, decode, and evidence", () => {
  test("MR14 Component versus document exports, validated by an independent validator", () => {
    const model = outline();
    for (const provider of PROVIDERS) {
      const props = exportComponentProperties(outlineSchema, "section", provider);
      expect([props.scope, props.route, props.tag]).toEqual([
        "componentProperties",
        "properties",
        "section",
      ]);
      // A component export describes only that component's props: no content, no nested components.
      expect(JSON.stringify(props.requestSchema)).not.toContain('"content"');
      const document = exportDocument(outlineSchema, provider);
      expect(document.scope).toBe("document");
      const wire = encodeProviderOutput(document, model, outlineSchema);
      expect({ provider, valid: independentValidator(document.requestSchema)(wire) }).toEqual({
        provider,
        valid: true,
      });
      const decoded = decodeProviderOutput(document, wire, outlineSchema);
      expect(decoded.ok && decoded.value).toEqual(model);
    }
  });

  test("MR15 Typed projection admits its own text rows and types props per kind", () => {
    const projection = exportDocument(outlineSchema, "anthropic", "rowProjection");
    const valid = independentValidator(projection.requestSchema);
    const wire = encodeProviderOutput(projection, outline(), outlineSchema) as {
      root: JsonObject;
      rows: JsonObject[];
    };
    expect(wire.rows.some((row) => typeof row["text"] === "string")).toBe(true);
    expect(valid(wire)).toBe(true);
    // Props depend on the row's kind: note props on a section row, or a note without its
    // required target, fail the generation schema (or, where weakened, the local check).
    const retype = (edit: (row: JsonObject) => JsonObject | undefined): JsonValue => ({
      root: wire.root,
      rows: wire.rows.map((row) => edit(row) ?? row),
    });
    const wrongKind = retype((row) =>
      row["tag"] === "section" ? { ...row, props: { target: "x", text: "y" } } : undefined,
    );
    const missing = retype((row) =>
      row["tag"] === "note" ? { ...row, props: { text: "y" } } : undefined,
    );
    for (const bad of [wrongKind, missing]) {
      const rejectedByGrammar = !valid(bad);
      const rejectedLocally = !decodeProviderOutput(projection, bad, outlineSchema).ok;
      expect(rejectedByGrammar || rejectedLocally).toBe(true);
      expect(rejectedLocally).toBe(true);
    }
    // Order, nesting, stable ids, and temporary wire references; duplicates are rejected.
    const decoded = decodeProviderOutput(projection, wire, outlineSchema);
    expect(decoded.ok && decoded.value).toEqual(outline());
    const duplicate = { root: wire.root, rows: [...wire.rows, { ...wire.rows[0] }] };
    expect(decodeProviderOutput(projection, duplicate, outlineSchema).ok).toBe(false);
    const reordered = { root: wire.root, rows: [...wire.rows].reverse() };
    const reorderedResult = decodeProviderOutput(projection, reordered, outlineSchema);
    expect(reorderedResult.ok && reorderedResult.value).not.toEqual(outline());
  });

  test("MR16 Real limits: measured emitted schemas just below, at, and above each budget", () => {
    for (const provider of PROVIDERS) {
      const { maxDepth, maxProperties, maxVariants } = PROVIDER_PROFILES[provider];
      const seen = {
        depth: new Set<boolean>(),
        properties: new Set<boolean>(),
        variants: new Set<boolean>(),
      };
      for (let depth = 1; depth <= maxDepth.value + 2; depth += 1) {
        const exported = exportComponentProperties(sized(depth, 1), "form", provider);
        const over = exported.measured.depth > maxDepth.value;
        seen.depth.add(over);
        expect(exported.incompatibilities.some((m) => m.includes("nesting depth"))).toBe(over);
      }
      for (const width of [maxProperties.value - 1, maxProperties.value, maxProperties.value + 1]) {
        const exported = exportComponentProperties(sized(0, width), "form", provider);
        expect(exported.measured.properties).toBe(width);
        const over = width > maxProperties.value;
        seen.properties.add(over);
        expect(exported.incompatibilities.some((m) => m.includes("properties exceed"))).toBe(over);
      }
      for (
        let unions = maxVariants.value / 4 - 2;
        unions <= maxVariants.value / 2 + 2;
        unions += 1
      ) {
        const exported = exportComponentProperties(sized(0, 1, unions), "form", provider);
        const over = exported.measured.variants > maxVariants.value;
        seen.variants.add(over);
        expect(exported.incompatibilities.some((m) => m.includes("variants exceed"))).toBe(over);
      }
      expect([seen.depth.size, seen.properties.size, seen.variants.size]).toEqual([2, 2, 2]);
      // Every enforcement claim is backed by the emitted schema; weakened constraints are local-only.
      for (const exported of [
        exportComponentProperties(outlineSchema, "section", provider),
        exportDocument(outlineSchema, provider),
      ]) {
        const text = JSON.stringify(exported.requestSchema);
        for (const claim of exported.generationEnforced)
          expect(text).toContain(`"${claim.split(":").pop() ?? ""}"`);
        for (const weakened of exported.localOnly)
          expect(exported.generationEnforced).not.toContain(weakened);
        for (const budget of Object.values(exported.budgets))
          expect(["documented", "internal"]).toContain(budget.basis);
      }
    }
    // Native recursion is used only where the profile supports it.
    expect(
      exportDocument(outlineSchema, "anthropic", "nativeTree").incompatibilities.join(" "),
    ).toContain("recursive");
  });

  test("MR17 Decoder validation and exceptional responses never yield applicable data", () => {
    const component = exportComponentProperties(outlineSchema, "section", "openai");
    const document = exportDocument(outlineSchema, "gemini", "nativeTree");
    const projection = exportDocument(outlineSchema, "anthropic", "rowProjection");
    const wire = encodeProviderOutput(projection, outline(), outlineSchema) as {
      root: JsonObject;
      rows: JsonObject[];
    };
    let deep = '"leaf"';
    for (let i = 0; i < 50_000; i += 1) deep = `[${deep}]`;
    const cases: [string, ProviderExport, Parameters<typeof decodeProviderResponse>[0]][] = [
      ["malformed JSON", component, { status: "ok", json: "{" }],
      ["refusal", component, { status: "refusal", reason: "policy" }],
      ["incomplete", document, { status: "incomplete", partialJson: '{"root":' }],
      ["schema error", document, { status: "schemaError", detail: "rejected" }],
      ["array container", component, { status: "ok", json: "[]" }],
      ["scalar container", document, { status: "ok", json: "3" }],
      [
        "rows not an array",
        projection,
        { status: "ok", json: JSON.stringify({ root: wire.root, rows: {} }) },
      ],
      [
        "row without ref",
        projection,
        {
          status: "ok",
          json: JSON.stringify({ ...wire, rows: [{ parent: "r0", tag: "para", props: {} }] }),
        },
      ],
      [
        "row props not an object",
        projection,
        {
          status: "ok",
          json: JSON.stringify({
            ...wire,
            rows: wire.rows.map((r) => ("tag" in r ? { ...r, props: [] } : r)),
          }),
        },
      ],
      [
        "missing required",
        component,
        {
          status: "ok",
          json: JSON.stringify({ slug: null, level: null, tags: null, draft: null }),
        },
      ],
      [
        "locally invalid",
        component,
        {
          status: "ok",
          json: JSON.stringify({
            heading: "h",
            slug: "Bad Slug",
            level: null,
            tags: null,
            draft: null,
          }),
        },
      ],
      ["hostile depth", component, { status: "ok", json: `{"heading":${deep}}` }],
      ["hostile keys", component, { status: "ok", json: '{"heading":"h","__proto__":{"x":1}}' }],
    ];
    for (const [name, exported, response] of cases)
      expect({ name, ok: decodeProviderResponse(response, exported, outlineSchema).ok }).toEqual({
        name,
        ok: false,
      });
    // Component and document decode apply the same effective-value policy (null ≡ omitted ≡ default).
    const fromComponent = decodeProviderOutput(
      component,
      { heading: "h", slug: null, level: null, tags: null, draft: null },
      outlineSchema,
    );
    expect(fromComponent.ok && fromComponent.value).toEqual({
      heading: "h",
      level: 1,
      draft: false,
    });
    const docWire = encodeProviderOutput(document, outline(), outlineSchema) as {
      root: JsonObject;
    };
    const nulled = JSON.parse(
      JSON.stringify(docWire).replace('"level":3', '"level":1'),
    ) as JsonValue;
    const fromDocument = decodeProviderOutput(document, nulled, outlineSchema);
    expect(fromDocument.ok).toBe(true);
    // A wire reference alone is not proof of a well-typed row.
    const forged = { root: wire.root, rows: [{ ref: "rz", parent: "r0", tag: "note", props: {} }] };
    expect(decodeProviderOutput(projection, forged, outlineSchema).ok).toBe(false);
  });

  test("MR18 Provider evidence and environment-independent default tests", () => {
    for (const provider of PROVIDERS) {
      const profile = PROVIDER_PROFILES[provider];
      expect(profile.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(profile.sources.length).toBeGreaterThan(0);
      for (const budget of [profile.maxDepth, profile.maxProperties, profile.maxVariants])
        expect(budget.note.length).toBeGreaterThan(0);
    }
    // The same offline provider suite with credential variables absent and present (harmless values).
    const fake = "sk-harmless-fixture-value-0000";
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/API_KEY|PROBE_LIVE/.test(k)),
    );
    const withKeys = {
      ...clean,
      OPENAI_API_KEY: fake,
      ANTHROPIC_API_KEY: fake,
      GEMINI_API_KEY: fake,
    };
    const suite = ["bun", "test", "tests/acceptance/s.test.ts"];
    const results = [run(suite, clean), run(suite, withKeys)].map(({ code, out }) => ({
      code,
      tests: out
        .split("\n")
        .filter((line) => line.startsWith("(pass)") || line.startsWith("(fail)"))
        .map((line) => line.replace(/ \[[\d.]+m?s\]$/, "")),
    }));
    expect(results[0]?.code).toBe(0);
    expect(results[1]).toEqual(results[0]);
    // Live probes are opt-in: without PROBE_LIVE nothing is sent, every provider reports skipped,
    // and no credential value is ever printed.
    for (const env of [withKeys, { ...clean, PROBE_LIVE: "1" }]) {
      const probe = run(["bun", "scripts/probe-live.ts"], env);
      expect(probe.code).toBe(0);
      expect(probe.out).not.toContain(fake);
      const lines = probe.out
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { provider: string; status: string; date: string; apiMode: string },
        );
      expect(lines.map((l) => [l.provider, l.status])).toEqual(
        PROVIDERS.map((p) => [p, "skipped"]),
      );
      expect(lines.every((l) => l.apiMode.length > 0 && /^\d{4}-/.test(l.date))).toBe(true);
    }
  });
});
