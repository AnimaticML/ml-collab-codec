# Schemas

A document schema is a JSON Schema 2020-12 manifest: one entry per component tag with its
identity policy, content model, and a standard JSON Schema for its properties.
`defineDocumentSchema` checks and compiles it once; every entry point (parse, JSON import,
validation, provider decode, the schema-backed authority) uses the compiled profile.

```ts
import assert from "node:assert/strict";
import {
  defineDocumentSchema,
  normalizeComponentProps,
  validateDocument,
  parseDocument,
} from "ml-collab-codec";

const schema = defineDocumentSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "example.notes",
  version: "1.0.0",
  rootTag: "notes",
  $defs: { label: { type: "string", pattern: "^[a-z-]+$" } },
  components: {
    notes: {
      identity: "none",
      content: { mode: "element", allowedTags: ["note", "link"] },
      props: {
        type: "object",
        properties: { title: { type: "string", minLength: 1 } },
        required: ["title"],
        additionalProperties: false,
      },
    },
    note: {
      identity: "stable", // carries a persistent id
      content: { mode: "mixed" }, // text and inline components
      props: {
        type: "object",
        properties: {
          slug: { type: "string", "x-reference": "definition" },
          tags: {
            type: "array",
            items: { $ref: "#/$defs/label" },
            maxItems: 5,
            "x-encoding": "comma",
          },
          votes: { type: "integer", minimum: 0, default: 0, "x-additive": true },
          pinned: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    link: {
      identity: "none",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { to: { type: "string", "x-reference": "reference" } },
        required: ["to"],
        additionalProperties: false,
      },
    },
  },
});

// One effective value: omitted, null, and the default are the same; 0/false/"" are data.
const a = normalizeComponentProps(schema, "note", {}, "$");
const b = normalizeComponentProps(schema, "note", { votes: null, pinned: false }, "$");
assert.deepEqual(a.value, b.value);
assert.deepEqual(a.value, { votes: 0, pinned: false });

// Diagnostics name the exact path; invalid values are never replaced by defaults.
const bad = normalizeComponentProps(schema, "note", { tags: ["ok", "Not Ok"], extra: 1 }, "$");
assert.deepEqual(bad.diagnostics.map((d) => [d.code, d.path]).sort(), [
  ["invalidValue", "$.tags[1]"],
  ["unknownProperty", "$.extra"],
]);

// References are checked in the final document state.
const parsed = parseDocument(
  `<notes title="Inbox"><note id="n1" slug="first">Hello</note><link to="first" /></notes>`,
  schema,
);
assert.ok(parsed.ok);
const dangling = { ...parsed.value.root, content: [{ tag: "link", props: { to: "missing" } }] };
assert.deepEqual(
  validateDocument(dangling, schema).map((d) => d.code),
  ["danglingReference"],
);
```

## Supported keywords

Assertions: `type` (`string`, `number`, `integer`, `boolean`, `array`, `object`; `null` is
not a type because null means "omitted"), `enum`, `const`, `minLength`, `maxLength`,
`pattern` (≤ 256 characters), `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `items`, `minItems`, `maxItems`, `uniqueItems`,
`properties`, `required`, `additionalProperties` (`false`, `true`, or a schema),
`minProperties`, `maxProperties`, `oneOf`, `anyOf`, and local `$ref` to `#/$defs/...`
(recursion allowed). Annotations: `title`, `description`, `default`, `examples`,
`deprecated`, `readOnly`, `writeOnly`, `$comment`. The exported `SUPPORTED_KEYWORDS`
set is authoritative. Anything else (`if`/`then`, `not`, `patternProperties`, `format`,
remote `$ref`, other dialects) is rejected at registration with a
`capabilityUnsupported` or `invalidSchema` diagnostic; nothing is silently ignored.

Library annotations:

| Annotation                    | Meaning                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `"x-additive": true`          | the integer field accepts relative `delta` operations (concurrent additions compose)        |
| `"x-reference": "definition"` | this string is a unique domain key (a second definition of the same value is `duplicateId`) |
| `"x-reference": "reference"`  | this string must name an existing definition in the final state (`danglingReference`)       |
| `"x-encoding": "comma"`       | a primitive array may be written as a comma attribute (`tags="a,b"`)                        |

Component options: `identity` (`"stable"` nodes carry persistent ids), `content.mode`
(`"mixed"` text and components, `"element"` components only — whitespace between them is
formatting, `"none"`), `content.allowedTags`, and `regionOwner` (a string property that
makes the component a visibility region; see [Collaboration](collaboration.md)). A schema
with `unknownComponents: "preserve"` keeps undeclared tags opaquely instead of rejecting
them.

## Defaults and required fields

A `default` must itself satisfy the property's schema (checked at registration), and a
property cannot be both `required` and defaulted. Defaults are materialized as a fresh copy
per document. A required property that is missing or null is `missingRequired`. A value of
the wrong type is `invalidValue` and is not defaulted.

## Limits

`SCHEMA_LIMITS` bounds schemas (depth 32, 10,000 schema nodes, pattern length).
`DOCUMENT_LIMITS` bounds documents (nesting depth 256, one million nodes, id length 256).
Deep, cyclic, or hostile inputs (`__proto__`, `constructor`, `prototype` keys) produce
diagnostics, never stack exhaustion or prototype pollution.

## Legacy compact profiles

`migrateLegacySchema(profile)` converts the pre-remediation compact descriptor to a
standard manifest (legacy strictness becomes `additionalProperties: false`), and
`registerSchema(profile)` compiles it directly. New code should author manifests.
