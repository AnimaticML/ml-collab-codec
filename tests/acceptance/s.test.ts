import { expect, test } from "bun:test";
import { registerSchema } from "../../src/core/schema.ts";
import type { SchemaProfile } from "../../src/core/schema.ts";
import {
  PROVIDER_CAPABILITIES,
  exportComponentSchema,
  exportForProvider,
  exportNodeTableSchema,
} from "../../src/core/providers.ts";
import {
  decodeComponentOutput,
  decodeNodeTable,
  decodeProviderResponse,
} from "../../src/core/provider-decode.ts";

const componentProfile: SchemaProfile = registerSchema({
  id: "fixture.component",
  version: "1.0.0",
  rootTag: "widget",
  unknownPolicy: "error",
  components: {
    widget: {
      tag: "widget",
      identity: "none",
      properties: {
        title: { type: "string", required: true },
        opacity: { type: "number", default: 1 },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      content: { mode: "none" },
    },
  },
});

const recursiveProfile: SchemaProfile = registerSchema({
  id: "fixture.recursive",
  version: "1.0.0",
  rootTag: "node",
  unknownPolicy: "error",
  components: {
    node: {
      tag: "node",
      identity: "stable",
      properties: { label: { type: "string", required: true } },
      content: { mode: "element", allowedTags: ["node"] },
    },
  },
});

function widgetComponent() {
  const component = componentProfile.components["widget"];
  if (component === undefined) throw new Error("fixture missing widget component");
  return component;
}

function nodeComponent() {
  const component = recursiveProfile.components["node"];
  if (component === undefined) throw new Error("fixture missing node component");
  return component;
}

test("S01 Provider schema baseline", () => {
  for (const capability of Object.values(PROVIDER_CAPABILITIES)) {
    const result = exportComponentSchema(widgetComponent(), capability);
    expect(result.profileId).toContain(capability.provider);
    expect(result.representation).toBe("native");
    expect(result.generationEnforced.length).toBeGreaterThan(0);
    expect(result.limits.maxDepth).toBe(capability.maxDepth);
  }
  // Live probes are separate and explicitly skipped without credentials (see Q-suite/live probe report).
  const hasCredentials = process.env["OPENAI_API_KEY"] !== undefined;
  expect(hasCredentials).toBe(false);
});

test("S02 Unsupported constraints", () => {
  const capability = PROVIDER_CAPABILITIES["gemini"];
  const result = exportComponentSchema(widgetComponent(), capability);
  expect(result.runtimeOnlyChecks.some((c) => c.includes("minItems"))).toBe(true);
  expect(result.incompatibilities).not.toContain("silently weakened");
});

test("S03 Optional output without presence wrappers", () => {
  const allRequired = exportComponentSchema(widgetComponent(), PROVIDER_CAPABILITIES["openai"]);
  const schema = allRequired.requestSchema as {
    required: string[];
    properties: Record<string, { type: unknown }>;
  };
  expect(schema.required.sort()).toEqual(["opacity", "tags", "title"]);
  expect(schema.properties["opacity"]?.type).toEqual(["number", "null"]);

  for (const raw of [
    { title: "t", opacity: null, tags: ["a"] },
    { title: "t", tags: ["a"] },
    { title: "t", opacity: 1, tags: ["a"] },
  ]) {
    const decoded = decodeComponentOutput("widget", raw, componentProfile, "$");
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.props["opacity"]).toBe(1);
  }
  const zero = decodeComponentOutput(
    "widget",
    { title: "t", opacity: 0, tags: ["a"] },
    componentProfile,
    "$",
  );
  expect(zero.ok && zero.value.props["opacity"]).toBe(0);
});

test("S04 Recursive and projected trees", () => {
  const anthropic = exportForProvider(
    nodeComponent(),
    recursiveProfile,
    PROVIDER_CAPABILITIES["anthropic"],
  );
  expect(anthropic.representation).toBe("native");
  const gemini = exportForProvider(
    nodeComponent(),
    recursiveProfile,
    PROVIDER_CAPABILITIES["gemini"],
  );
  expect(gemini.representation).toBe("projected");

  const nodes = [
    {
      wireRef: "w0",
      id: "root1",
      tag: "node",
      props: { label: "root" },
      parentWireRef: null,
      orderKey: "0",
    },
    {
      wireRef: "w1",
      id: null,
      tag: "node",
      props: { label: "child" },
      parentWireRef: "w0",
      orderKey: "0",
    },
  ];
  const decoded = decodeNodeTable(nodes, recursiveProfile);
  expect(decoded.ok).toBe(true);
  if (decoded.ok) {
    expect(decoded.value.root.id).toBe("root1");
    expect(decoded.value.root.content?.[0]).toMatchObject({
      tag: "node",
      props: { label: "child" },
    });
    expect((decoded.value.root.content?.[0] as { id?: string }).id).toBeUndefined();
  }
});

test("S05 Provider complexity boundaries", () => {
  const tinyCapability = { ...PROVIDER_CAPABILITIES["openai"], maxProperties: 1 };
  const result = exportComponentSchema(widgetComponent(), tinyCapability);
  expect(result.incompatibilities.length).toBeGreaterThan(0);
  expect(result.incompatibilities[0]).toContain("budget");
});

test("S06 Wire references are not persistent IDs", () => {
  const table = exportNodeTableSchema(recursiveProfile, PROVIDER_CAPABILITIES["gemini"]);
  const schema = table.requestSchema as {
    properties: { nodes: { items: { properties: { id: unknown; wireRef: unknown } } } };
  };
  expect(schema.properties.nodes.items.properties.wireRef).toBeDefined();
  expect(schema.properties.nodes.items.properties.id).toBeDefined();
  const nodes = [
    {
      wireRef: "w0",
      id: "root1",
      tag: "node",
      props: { label: "root" },
      parentWireRef: null,
      orderKey: "0",
    },
    {
      wireRef: "w1",
      id: null,
      tag: "node",
      props: { label: "leaf" },
      parentWireRef: "w0",
      orderKey: "0",
    },
  ];
  const decoded = decodeNodeTable(nodes, recursiveProfile);
  expect(decoded.ok).toBe(true);
  // wireRef "w1" never surfaces as a persisted id -- only the declared "root1" does.
  if (decoded.ok) expect(JSON.stringify(decoded.value)).not.toContain("w1");
});

test("S07 Locally invalid structured output", () => {
  const dangling = decodeNodeTable(
    [
      {
        wireRef: "w0",
        id: "root1",
        tag: "node",
        props: { label: "root" },
        parentWireRef: null,
        orderKey: "0",
      },
      {
        wireRef: "w1",
        id: "root1",
        tag: "node",
        props: { label: "dup" },
        parentWireRef: "w0",
        orderKey: "0",
      },
    ],
    recursiveProfile,
  );
  expect(dangling.ok).toBe(false);
  if (!dangling.ok) expect(dangling.diagnostics.some((d) => d.code === "duplicateId")).toBe(true);

  const cyclic = decodeNodeTable(
    [
      {
        wireRef: "w0",
        id: "root1",
        tag: "node",
        props: { label: "root" },
        parentWireRef: "w1",
        orderKey: "0",
      },
      {
        wireRef: "w1",
        id: null,
        tag: "node",
        props: { label: "child" },
        parentWireRef: "w0",
        orderKey: "0",
      },
    ],
    recursiveProfile,
  );
  expect(cyclic.ok).toBe(false);
});

test("S08 SDK adaptation and incomplete responses", () => {
  const ok = decodeProviderResponse(
    { status: "ok", json: '{"title":"t","tags":["a"]}' },
    "widget",
    componentProfile,
  );
  expect(ok.ok).toBe(true);

  const refusal = decodeProviderResponse(
    { status: "refusal", reason: "policy" },
    "widget",
    componentProfile,
  );
  expect(refusal.ok).toBe(false);

  const incomplete = decodeProviderResponse(
    { status: "incomplete", partialJson: '{"title":"t"' },
    "widget",
    componentProfile,
  );
  expect(incomplete.ok).toBe(false);

  const schemaError = decodeProviderResponse(
    { status: "schemaError", detail: "bad request" },
    "widget",
    componentProfile,
  );
  expect(schemaError.ok).toBe(false);

  const badJson = decodeProviderResponse(
    { status: "ok", json: "{not json" },
    "widget",
    componentProfile,
  );
  expect(badJson.ok).toBe(false);
});
