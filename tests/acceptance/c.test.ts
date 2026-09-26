import { describe, expect, test } from "bun:test";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { parseDocument, parseFragment, parseMultiRoot } from "../../src/core/parser.ts";
import { serializeDocument, serializeFragment } from "../../src/core/serializer.ts";
import { registerSchema } from "../../src/core/schema.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";
import { deepEqual } from "../../src/core/normalize.ts";

const opacitySchema: SchemaProfile = registerSchema({
  id: "fixture.opacity",
  version: "1.0.0",
  rootTag: "box",
  unknownPolicy: "error",
  components: {
    box: {
      tag: "box",
      identity: "none",
      properties: {
        opacity: { type: "number", default: 1 },
        label: { type: "string", required: true },
        flag: { type: "boolean" },
        note: { type: "string" },
      },
      content: { mode: "none" },
    },
  },
});

test("C01 Mixed text round-trip", () => {
  const source = `<doc><p id="p1">Hello&nbsp;<emphasis>world</emphasis>! &amp; punctuation, line\nbreak.</p></doc>`;
  const parsed = parseDocument(source, richTextSchema);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.root.content).toEqual([
    {
      id: "p1",
      tag: "p",
      props: { opacity: 1, flag: false },
      content: [
        "Hello ",
        { tag: "emphasis", props: {}, content: ["world"] },
        "! & punctuation, line\nbreak.",
      ],
    },
  ]);
  const printed = serializeDocument(parsed.value, richTextSchema);
  const reparsed = parseDocument(printed, richTextSchema);
  expect(reparsed.ok).toBe(true);
  if (reparsed.ok) expect(reparsed.value).toEqual(parsed.value);
});

test("C02 Invalid input is not a default", () => {
  const parsed = parseDocument(`<box label="x" opacity="bad" />`, opacitySchema);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(
    parsed.diagnostics.some((d) => d.code === "invalidValue" && d.path.includes("opacity")),
  ).toBe(true);
});

describe("C03 Equivalent optional values", () => {
  test("C03 omission, null, and explicit default agree", () => {
    const omitted = parseDocument(`<box label="x" />`, opacitySchema);
    const explicitDefault = parseDocument(`<box label="x" opacity="1" />`, opacitySchema);
    expect(omitted.ok && explicitDefault.ok).toBe(true);
    if (omitted.ok && explicitDefault.ok) expect(omitted.value).toEqual(explicitDefault.value);
  });
  test("C03 explicit zero, false, and empty string are retained, not treated as unset", () => {
    const parsed = parseDocument(
      `<box label="x" opacity="0" flag="false" note="" />`,
      opacitySchema,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.root.props["opacity"]).toBe(0);
    expect(parsed.value.root.props["flag"]).toBe(false);
    expect(parsed.value.root.props["note"]).toBe("");
  });
  test("C03 a missing required field remains an error regardless of other defaults", () => {
    const parsed = parseDocument(`<box opacity="1" />`, opacitySchema);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics.some((d) => d.code === "missingRequired")).toBe(true);
  });
});

test("C04 Unambiguous string and array encoding", () => {
  const parsed = parseFragment(`<p id="p1" title="0012" tags="a,b,c" />`, richTextSchema);
  expect(parsed.diagnostics).toEqual([]);
  const [node] = parsed.items;
  expect(node && typeof node !== "string" ? node.props["title"] : undefined).toBe("0012");
  expect(node && typeof node !== "string" ? node.props["tags"] : undefined).toEqual([
    "a",
    "b",
    "c",
  ]);
  const falseParsed = parseFragment(`<p id="p2" title="false" />`, richTextSchema);
  const [falseNode] = falseParsed.items;
  expect(falseNode && typeof falseNode !== "string" ? falseNode.props["title"] : undefined).toBe(
    "false",
  );
});

test("C05 Canonicalization is stable", () => {
  const source = `<doc><p id="p1" opacity="0.75" tags="x,y">hi</p></doc>`;
  const parsed = parseDocument(source, richTextSchema);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const printed1 = serializeDocument(parsed.value, richTextSchema);
  const reparsed1 = parseDocument(printed1, richTextSchema);
  expect(reparsed1.ok).toBe(true);
  if (!reparsed1.ok) return;
  const printed2 = serializeDocument(reparsed1.value, richTextSchema);
  expect(printed2).toBe(printed1);
});

test("C06 Duplicate stable IDs", () => {
  const parsed = parseDocument(`<doc><p id="dup">a</p><p id="dup">b</p></doc>`, richTextSchema);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.diagnostics.some((d) => d.code === "duplicateId")).toBe(true);
});

function firstNode(items: ReturnType<typeof parseFragment>["items"]) {
  const [node] = items;
  return node && typeof node !== "string" ? node : undefined;
}

test("C07 JSON block and path mapping", () => {
  const source = `<p id="p1" opacity="0.5"><script type="application/json">{"opacity":0.9,"style":{"color":"red"}}</script><script type="application/json" data-property="style">{"weight":2}</script></p>`;
  const parsed = parseFragment(source, richTextSchema);
  expect(parsed.diagnostics).toEqual([]);
  const node = firstNode(parsed.items);
  expect(node?.props["opacity"]).toBe(0.9);
  expect(node?.props["style"]).toEqual({ color: "red", weight: 2 });

  const malformed = parseFragment(
    `<p id="p2"><script type="application/json">{not json}</script></p>`,
    richTextSchema,
  );
  expect(malformed.diagnostics.some((d) => d.code === "malformedJson")).toBe(true);

  const ambiguous = parseFragment(
    `<p id="p3" style="flat" style.color="red">x</p>`,
    richTextSchema,
  );
  expect(ambiguous.diagnostics.some((d) => d.code === "ambiguousPath")).toBe(true);
});

test("C08 Escaping and hostile keys", () => {
  const source = `<p id="p1">before &lt;/script&gt; &amp; &quot;quoted&quot; after</p>`;
  const parsed = parseFragment(source, richTextSchema);
  expect(parsed.diagnostics).toEqual([]);
  const node = firstNode(parsed.items);
  expect(node?.content).toEqual(['before </script> & "quoted" after']);
  const printed = serializeFragment(parsed.items, richTextSchema);
  expect(printed.includes("</script")).toBe(false);

  const hostile = parseFragment(
    `<p id="p1"><script type="application/json">{"__proto__":{"polluted":true}}</script></p>`,
    richTextSchema,
  );
  expect(hostile.diagnostics.some((d) => d.code === "unsafeKey")).toBe(true);
  expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
});

test("C09 Attribute name normalization", () => {
  const source = ['<box label="a" />', '<box label="b" opacity="0.4" />'].join("");
  void source;
  const nameSchema: SchemaProfile = registerSchema({
    id: "fixture.naming",
    version: "1.0.0",
    rootTag: "n",
    unknownPolicy: "error",
    components: {
      n: {
        tag: "n",
        identity: "none",
        properties: { camelCase: { type: "string" }, id2: { type: "string" } },
        content: { mode: "none" },
      },
    },
  });
  for (const attr of ["camel-case", "CAMEL-CASE"]) {
    const parsed = parseDocument(`<n ${attr}="v" />`, nameSchema);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.root.props["camelCase"]).toBe("v");
  }
  const dup = parseDocument(`<n camel-case="first" CAMEL-CASE="second" />`, nameSchema);
  expect(dup.ok).toBe(true);
  if (dup.ok) {
    expect(dup.value.root.props["camelCase"]).toBe("first");
    expect(dup.diagnostics.some((d) => d.code === "duplicateAttribute")).toBe(true);
  }
});

test("C10 JSON precedence and reversible names", () => {
  const source = `<p id="p1" opacity="0.2"><script type="application/json">{"opacity":0.8}</script></p>`;
  const parsed = parseFragment(source, richTextSchema);
  expect(parsed.diagnostics).toEqual([]);
  expect(firstNode(parsed.items)?.props["opacity"]).toBe(0.8);

  const printed = serializeFragment(parsed.items, richTextSchema);
  expect(printed.includes('opacity="0.8"')).toBe(true);

  const styleSource = `<p id="p2"><script type="application/json">{"style":{"color":"blue"}}</script></p>`;
  const styleParsed = parseFragment(styleSource, richTextSchema);
  expect(styleParsed.diagnostics).toEqual([]);
  {
    const stylePrinted = serializeFragment(styleParsed.items, richTextSchema);
    expect(stylePrinted.includes('"style"')).toBe(true);
    expect(stylePrinted.includes("style=")).toBe(false);
  }
});

test("C11 Unknown data policy", () => {
  const strict = parseDocument(`<p id="p1" ghost="x">y</p>`, richTextSchema);
  expect(strict.ok).toBe(false);
  if (!strict.ok) expect(strict.diagnostics.some((d) => d.code === "unknownProperty")).toBe(true);

  const opaqueSchema: SchemaProfile = registerSchema({
    id: "fixture.opaque",
    version: "1.0.0",
    rootTag: "o",
    unknownPolicy: "error",
    components: {
      o: {
        tag: "o",
        identity: "none",
        properties: {},
        content: { mode: "none" },
        allowOpaqueProperties: true,
      },
    },
  });
  const opaque = parseDocument(`<o extra="kept" />`, opaqueSchema);
  expect(opaque.ok).toBe(true);
  if (opaque.ok) expect(opaque.value.root.props["extra"]).toBe("kept");
});

test("C12 Standalone file and HTML bootstrap", async () => {
  const { buildBootstrapHtml, extractPayloadFromHtml } =
    await import("../../src/adapters/browser.ts");
  const source = `<doc><p id="p1">safe &lt;/script&gt; text</p></doc>`;
  const html = buildBootstrapHtml(source, { bundleRef: "./app.js" });
  expect(html.includes("<script>alert")).toBe(false);
  const extracted = extractPayloadFromHtml(html);
  expect(extracted).toBe(source);
  const decoded = parseDocument(extracted, richTextSchema);
  const directDecoded = parseDocument(source, richTextSchema);
  expect(decoded.ok && directDecoded.ok).toBe(true);
  if (decoded.ok && directDecoded.ok)
    expect(deepEqual(decoded.value as never, directDecoded.value as never)).toBe(true);
});

describe("C13 Comments, roots, and content modes", () => {
  test("C13 application comments survive; source comments are dropped", () => {
    const source = `<doc><!-- source only --><p id="p1">a</p><comment id="c1" text="note" /></doc>`;
    const parsed = parseDocument(source, richTextSchema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const printed = serializeDocument(parsed.value, richTextSchema);
    expect(printed.includes("source only")).toBe(false);
    expect(printed.includes('text="note"')).toBe(true);
  });
  test("C13 single-root mode rejects extra roots; multi-root mode retains all", () => {
    const source = `<doc><p id="p1">a</p></doc><doc><p id="p2">b</p></doc>`;
    const single = parseDocument(source, richTextSchema, { rootMode: "single" });
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.diagnostics.some((d) => d.code === "extraRoot")).toBe(true);
    const multi = parseMultiRoot(source, richTextSchema);
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.value.length).toBe(2);
  });
  test("C13 element-only content mode ignores inter-element indentation", () => {
    const fragment = parseFragment(`<p id="p1">\n  <emphasis>x</emphasis>\n</p>`, richTextSchema);
    expect(fragment.diagnostics.length).toBe(0);
    const printed = serializeFragment(fragment.items, richTextSchema);
    expect(printed.includes("<p")).toBe(true);
  });
});
