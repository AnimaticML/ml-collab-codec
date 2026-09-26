// Exercises the schema/codec/validation/provider/visibility part of the public
// API (src/index.ts) end to end, using only exported entry points -- the
// "separate consumer" contract that the built package (tests/fixtures/
// consumer-check.mjs, Q02) also verifies.
import { expect, test } from "bun:test";
import {
  attributeNameToProperty,
  createAllocator,
  decodeDocumentJson,
  decodeProviderOutput,
  decodeProviderResponse,
  deepEqual,
  defineDocumentSchema,
  DiagnosticError,
  DOCUMENT_LIMITS,
  editableCopy,
  encodeProviderOutput,
  err,
  exportComponentProperties,
  exportDocument,
  findNodeById,
  fromTable,
  getComponentSchema,
  isComponentNode,
  migrateLegacySchema,
  normalizeComponentProps,
  normalizeDocument,
  ok,
  parseDocument,
  parseFragment,
  parseMultiRoot,
  projectTable,
  PROVIDER_PROFILES,
  PUBLIC_REGION,
  regionOwner,
  registerSchema,
  RestrictedAuthority,
  SCHEMA_LIMITS,
  serializeDocument,
  serializeFragment,
  SUPPORTED_KEYWORDS,
  toTable,
  validateDocument,
  validateTable,
} from "../../src/index.ts";
import type {
  ActionHandler,
  AdditionalPolicy,
  Budget,
  ComponentDefinition,
  ComponentNode,
  ComponentSchema,
  ContentItem,
  ContentMode,
  Diagnostic,
  DiagnosticCode,
  DocumentModel,
  DocumentSchemaDefinition,
  EditableDocument,
  EditableNode,
  JsonObject,
  JsonScalar,
  JsonSchema,
  JsonValue,
  LegacyComponentSchema,
  LegacyPropertySchema,
  LegacySchemaProfile,
  Located,
  MutableJsonValue,
  PropertySchema,
  ProviderExport,
  ProviderId,
  ProviderProfile,
  ProviderResponse,
  RestrictedDecision,
  Result,
  SchemaProfile,
  SourceSpan,
  ValueType,
} from "../../src/index.ts";

const mixedMode: ContentMode = "mixed";
const noteSchema: JsonSchema = { type: "string", maxLength: 40 };
const paragraph: ComponentDefinition = {
  identity: "stable",
  content: { mode: mixedMode },
  props: { type: "object", properties: { note: noteSchema }, additionalProperties: false },
};
const definition: DocumentSchemaDefinition = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "api.rich-text",
  version: "1.0.0",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: mixedMode, allowedTags: ["p"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    p: paragraph,
  },
};
const schema: SchemaProfile = defineDocumentSchema(definition);

test("public API: schema, codec, diagnostics, validation, and ownership", () => {
  const parsed = parseDocument(`<doc><p id="p1">hi</p></doc>`, schema);
  const asResult: Result<DocumentModel> = parsed;
  if (!asResult.ok) throw new Error("setup");
  const model: DocumentModel = asResult.value;
  const root: ComponentNode = model.root;
  const content: readonly ContentItem[] = root.content ?? [];
  expect(content.some((item) => isComponentNode(item))).toBe(true);
  expect(serializeDocument(model, schema)).toContain("<p");
  const fragment = parseFragment(`<p id="p2">x</p> tail`, schema);
  expect(fragment.ok && serializeFragment(fragment.value, schema)).toBe(`<p id="p2">x</p> tail`);
  const multi = parseMultiRoot(`<p id="p3">a</p><p id="p4">b</p>`, schema);
  expect(multi.ok && multi.value.length).toBe(2);
  expect(attributeNameToProperty("camel-case")).toBe("camelCase");

  const component: ComponentSchema | undefined = getComponentSchema(schema, "p");
  const note: PropertySchema | undefined = component?.properties["note"];
  const type: ValueType | undefined = note?.type;
  const additional: AdditionalPolicy | undefined = component?.props.additional;
  expect([type, additional?.kind]).toEqual(["string", "reject"]);
  expect(SUPPORTED_KEYWORDS.has("maxLength") && SCHEMA_LIMITS.maxDepth > 0).toBe(true);
  expect(
    normalizeComponentProps(schema, "p", { note: "x".repeat(41) }, "$").diagnostics,
  ).toHaveLength(1);

  // The legacy compact profile compiles through the same path.
  const legacyNote: LegacyPropertySchema = { type: "string" };
  const legacyP: LegacyComponentSchema = {
    tag: "p",
    identity: "stable",
    properties: { note: legacyNote },
    content: { mode: "mixed" },
  };
  const legacy: LegacySchemaProfile = {
    id: "api.legacy",
    version: "1",
    rootTag: "p",
    unknownPolicy: "error",
    components: { p: legacyP },
  };
  expect(migrateLegacySchema(legacy).components["p"]?.props.additionalProperties).toBe(false);
  expect(registerSchema(legacy).rootTag).toBe("p");

  const json = decodeDocumentJson(JSON.parse(JSON.stringify(model)), schema);
  expect(json.ok && json.value).toEqual(model);
  expect(normalizeDocument(root, schema).diagnostics).toEqual([]);
  expect(validateDocument(root, schema)).toEqual([]);
  expect(validateTable(toTable(model, createAllocator()), schema)).toEqual([]);
  expect(DOCUMENT_LIMITS.maxDepth).toBeGreaterThan(0);

  const copy: EditableDocument = editableCopy(model);
  const edited: MutableJsonValue = "changed";
  copy.root.props["extra"] = edited;
  const node: EditableNode = copy.root;
  expect(node.tag).toBe("doc");
  expect(model.root.props["extra"]).toBeUndefined();
  const left: JsonValue = { a: 1 };
  const scalar: JsonScalar = "x";
  const obj: JsonObject = { a: scalar };
  expect(deepEqual(left, { a: 1 }) && obj["a"] === "x").toBe(true);
  const located: Located | undefined = findNodeById(root, "p1");
  expect(located?.node.id).toBe("p1");

  const diagnosticCode: DiagnosticCode = "invalidValue";
  const diagnostic: Diagnostic = { code: diagnosticCode, message: "m", path: "$" };
  const span: SourceSpan = { start: 0, end: 1 };
  expect(() => {
    throw new DiagnosticError([diagnostic]);
  }).toThrow(DiagnosticError);
  expect(ok(1).ok && !err([diagnostic]).ok && span.start === 0).toBe(true);
});

test("public API: provider export/decode and visibility", () => {
  const id: ProviderId = "anthropic";
  const profile: ProviderProfile = PROVIDER_PROFILES[id];
  const budget: Budget = profile.maxDepth;
  expect(budget.basis).toBe("internal");
  const props: ProviderExport = exportComponentProperties(schema, "p", id);
  const document: ProviderExport = exportDocument(schema, id);
  expect([props.scope, document.scope, document.route]).toEqual([
    "componentProperties",
    "document",
    "rowProjection",
  ]);
  const model = parseDocument(`<doc>a<p id="p1" note="n">x</p></doc>`, schema);
  if (!model.ok) throw new Error("setup");
  const wire = encodeProviderOutput(document, model.value, schema);
  const decoded = decodeProviderOutput(document, wire, schema);
  expect(decoded.ok && decoded.value).toEqual(model.value);
  const response: ProviderResponse = { status: "ok", json: '{"note":"n"}' };
  expect(decodeProviderResponse(response, props, schema).ok).toBe(true);

  const restricted = new RestrictedAuthority(
    schema,
    "doc",
    "epoch",
    toTable(model.value, createAllocator()),
  );
  expect(regionOwner(restricted.view("anyone"), schema, "p1")).toBe(PUBLIC_REGION);
  expect(projectTable(restricted.view("anyone"), schema, PUBLIC_REGION).size).toBeGreaterThan(0);
  expect(fromTable(restricted.fullView(), schema.id, schema.version)).toEqual(model.value);
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
