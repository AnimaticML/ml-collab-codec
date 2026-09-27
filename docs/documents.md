# Documents and source format

A document is a tree of components defined by a [schema](schemas.md). It has two
equivalent persisted forms — readable tagged source and a JSON model — and one working
form for editing, the operational table.

## Tagged source

```html
<doc id="d1">
  <p id="p1" title="Intro">Hello <em>big</em> world</p>
  <p id="p2">
    <script type="application/json">
      { "style": { "color": "red" }, "tags": ["a", "b"] }
    </script>
    Second
  </p>
</doc>
```

- An element is a component; its tag must be declared unless the schema preserves
  unknown components. `id` is the persistent identity of a `stable` component.
- Scalars may be attributes; kebab-case attribute names map to camelCase properties, and
  a dotted attribute (`style.color="red"`) addresses a nested member. Structured values go
  in one `<script type="application/json">` block per component. A value given twice is an
  `ambiguousPath` or `duplicateAttribute` diagnostic.
- Text is significant in `mixed` content (entities, whitespace, Unicode are preserved)
  and is formatting in `element` content. HTML comments in the source are dropped;
  application comments belong in the schema as components.
- Printing is canonical and lossless: `parse(print(model))` equals the model, reprinting is
  byte-stable, and a value the format cannot carry (for example `NaN`) is refused with a
  `DiagnosticError` rather than printed differently.

## JSON model

`DocumentModel` is `{ schemaId, schemaVersion, root }`; a node is
`{ id?, tag, props, content? }` where content items are strings or nodes. The
`schemaId`/`schemaVersion` pair declares the interpretation; `decodeDocumentJson` refuses a
different one. JSON is the recommended storage form for applications; source is for
people, diffs, and agents.

```ts
import assert from "node:assert/strict";
import {
  decodeDocumentJson,
  defineDocumentSchema,
  parseDocument,
  parseFragment,
  parseMultiRoot,
  serializeDocument,
} from "ml-collab-codec";

const closed = { type: "object", properties: {}, additionalProperties: false } as const;
const schema = defineDocumentSchema({
  id: "example.doc",
  version: "1",
  rootTag: "doc",
  components: {
    doc: { identity: "stable", content: { mode: "element", allowedTags: ["p"] }, props: closed },
    p: {
      identity: "stable",
      content: { mode: "mixed", allowedTags: ["em"] },
      props: {
        type: "object",
        properties: { title: { type: "string" }, level: { type: "integer", default: 1 } },
        additionalProperties: false,
      },
    },
    em: { identity: "none", content: { mode: "mixed" }, props: closed },
  },
});

const source = `<doc id="d1"><p id="p1" title="Intro">Hello <em>big</em> world</p></doc>`;
const parsed = parseDocument(source, schema);
assert.ok(parsed.ok);
// The effective value is materialized: level defaults to 1.
assert.deepEqual(parsed.value.root.content?.[0], {
  id: "p1",
  tag: "p",
  props: { title: "Intro", level: 1 },
  content: ["Hello ", { tag: "em", props: {}, content: ["big"] }, " world"],
});
// Canonical print omits defaults and round-trips.
const printed = serializeDocument(parsed.value, schema);
assert.equal(printed, source);
// Saved JSON reopens to the same model; another schema version is refused.
const saved = JSON.parse(JSON.stringify(parsed.value));
assert.deepEqual(decodeDocumentJson(saved, schema), {
  ok: true,
  value: parsed.value,
  diagnostics: [],
});
assert.equal(decodeDocumentJson({ ...saved, schemaVersion: "2" }, schema).ok, false);

// Exactly one root for a document; a multi-root parse returns every root; fragments keep text.
assert.equal(parseDocument(`${source}${source}`, schema).ok, false);
const roots = parseMultiRoot(`<p id="a">1</p><p id="b">2</p>`, schema);
assert.deepEqual(roots.ok && roots.value.map((r) => r.id), ["a", "b"]);
const fragment = parseFragment(`lead <p id="c">x</p>`, schema);
assert.equal(fragment.ok && fragment.value[0], "lead ");
```

## Effective values

Validation and editing see one effective value: an omitted optional property, `null`, and
the declared default are the same value, and defaults are materialized. `false`, `0`, and
`""` are real values, never "unset". Invalid input produces diagnostics with a stable code
and path (`invalidValue`, `missingRequired`, `unknownProperty`, `duplicateId`,
`danglingReference`, `invalidNesting`, `limitExceeded`, ...); it is never replaced by a
default.

## The operational table

`toTable(model, createAllocator())` builds the editing form: a flat `Table` of rows
`{ id, tag, props, parentId, children, persisted }`. Every row, including each text run and
anonymous component, has an id; only `persisted` ids appear in the model. The root row is
addressed as `$root` (`ROOT_ID`) and keeps the document's own id in `rootId`. Internal
handles are stable for the life of a table and are carried by snapshots and checkpoints;
never regenerate them by re-parsing source during collaboration. `fromTable` returns the
model (adjacent text runs merge; empty runs disappear).

Local files need no room, server, or history: parse, edit with a `ChangeBuilder`, and
print (see [Operations](operations.md)).
