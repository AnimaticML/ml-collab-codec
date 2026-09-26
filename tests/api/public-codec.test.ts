// Exercises the codec/provider/visibility part of the public API (src/index.ts)
// end to end, using only exported entry points -- the "separate consumer"
// contract that the built package (tests/fixtures/consumer-check.mjs, Q02) also verifies.
import { expect, test } from "bun:test";
import {
  attributeNameToProperty,
  createAllocator,
  decodeComponentOutput,
  decodeNodeTable,
  decodeProviderResponse,
  deepEqual,
  DiagnosticError,
  err,
  exportComponentSchema,
  exportForProvider,
  exportNodeTableSchema,
  findNodeById,
  getComponentSchema,
  isComponentNode,
  normalizeComponentProps,
  normalizeProperties,
  ok,
  parseDocument,
  parseFragment,
  parseMultiRoot,
  projectTable,
  PROVIDER_CAPABILITIES,
  PUBLIC_REGION,
  regionOwner,
  registerSchema,
  RestrictedAuthority,
  serializeDocument,
  serializeFragment,
  toTable,
  validateDocument,
} from "../../src/index.ts";
import type {
  ActionHandler,
  ComponentNode,
  ComponentSchema,
  ContentItem,
  ContentMode,
  Diagnostic,
  DiagnosticCode,
  DocumentModel,
  ExportResult,
  JsonObject,
  JsonScalar,
  JsonValue,
  Located,
  ParseOptions,
  ProviderCapability,
  ProviderResponse,
  PropertySchema,
  PropertyType,
  RestrictedDecision,
  Result,
  SchemaProfile,
  SourceSpan,
} from "../../src/index.ts";

const mixedMode: ContentMode = "mixed";
const stringPropertyType: PropertyType = "string";

const schema: SchemaProfile = registerSchema({
  id: "api.rich-text",
  version: "1.0.0",
  rootTag: "doc",
  unknownPolicy: "error",
  components: {
    doc: {
      tag: "doc",
      identity: "none",
      properties: {},
      content: { mode: mixedMode, allowedTags: ["p"] },
    },
    p: {
      tag: "p",
      identity: "stable",
      properties: { note: { type: stringPropertyType } },
      content: { mode: mixedMode },
    },
  } satisfies Record<string, ComponentSchema>,
});

test("public API: codec, diagnostics, and schema introspection", () => {
  const parsed = parseDocument(`<doc><p id="p1">hi</p></doc>`, schema);
  const asResult: Result<DocumentModel> = parsed;
  expect(asResult.ok).toBe(true);
  if (!asResult.ok) return;
  const model: DocumentModel = asResult.value;
  const root: ComponentNode = model.root;
  const content: readonly ContentItem[] = root.content ?? [];
  expect(content.some((item) => isComponentNode(item))).toBe(true);
  expect(serializeDocument(model, schema)).toContain("<p");

  const fragment = parseFragment(`<p id="p2">x</p>`, schema);
  expect(serializeFragment(fragment.items, schema).length).toBeGreaterThan(0);
  const multi = parseMultiRoot(`<p id="p3">a</p><p id="p4">b</p>`, schema);
  expect(multi.ok && multi.value.length).toBe(2);
  const parseOpts: ParseOptions = { rootMode: "single" };
  expect(parseDocument(`<doc><p id="p5">z</p></doc>`, schema, parseOpts).ok).toBe(true);

  expect(attributeNameToProperty("camel-case")).toBe("camelCase");
  expect(getComponentSchema(schema, "p")?.tag).toBe("p");
  const propSchema: PropertySchema = { type: "string" };
  expect(propSchema.type).toBe("string");

  const normalized = normalizeComponentProps(
    getComponentSchema(schema, "p") as ComponentSchema,
    { note: "x" },
    "$",
  );
  expect(normalized.value["note"]).toBe("x");
  expect(normalizeProperties({}, {}, "$").diagnostics).toEqual([]);
  const left: JsonValue = { a: 1 };
  const right: JsonValue = { a: 1 };
  expect(deepEqual(left, right)).toBe(true);

  const scalar: JsonScalar = "x";
  const value: JsonValue = scalar;
  const obj: JsonObject = { a: value };
  expect(obj["a"]).toBe("x");

  const located: Located | undefined = findNodeById(root, "p1");
  expect(located?.node.id).toBe("p1");

  const diagnosticCode: DiagnosticCode = "invalidValue";
  const diagnostic: Diagnostic = {
    code: diagnosticCode,
    message: "m",
    path: "$",
  };
  const span: SourceSpan = { start: 0, end: 1 };
  expect(() => {
    throw new DiagnosticError([diagnostic]);
  }).toThrow(DiagnosticError);
  expect(ok(1).ok).toBe(true);
  expect(err([diagnostic]).ok).toBe(false);
  expect(span.start).toBe(0);
  expect(validateDocument(root, schema)).toEqual([]);
});

test("public API: provider export/decode and visibility", () => {
  const capability: ProviderCapability = PROVIDER_CAPABILITIES.anthropic;
  const componentSchema = getComponentSchema(schema, "p") as ComponentSchema;
  const exported: ExportResult = exportComponentSchema(componentSchema, capability);
  expect(exported.representation).toBe("native");
  expect(exportNodeTableSchema(schema, capability).representation).toBe("projected");
  expect(exportForProvider(componentSchema, schema, capability).requestSchema).toBeDefined();

  const decoded = decodeComponentOutput("p", { note: "n" }, schema, "$");
  expect(decoded.ok).toBe(true);
  const response: ProviderResponse = { status: "ok", json: '{"note":"n"}' };
  expect(decodeProviderResponse(response, "p", schema).ok).toBe(true);
  expect(decodeNodeTable([], schema).ok).toBe(false);

  const restricted = new RestrictedAuthority(
    schema,
    "doc",
    "epoch",
    toTable(
      (parseDocument(`<doc><p id="p1">x</p></doc>`, schema) as { ok: true; value: DocumentModel })
        .value,
      createAllocator(),
    ),
  );
  expect(regionOwner(restricted.view("anyone"), schema, "p1")).toBe(PUBLIC_REGION);
  expect(projectTable(restricted.view("anyone"), schema, PUBLIC_REGION).size).toBeGreaterThan(0);
  const handler: ActionHandler = (_table, principal) => principal === "owner";
  restricted.registerAction("noop", handler);
  const refused: RestrictedDecision = restricted.submitAction(
    "stranger",
    "noop",
    {},
    { replica: "replica-s", seq: 1 },
  );
  expect(refused.decision).toMatchObject({ receipt: { outcome: "rejected" } });
});
