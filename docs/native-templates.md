# Native templates and semantic actions

Add `compositionComponents` to the host schema and permit definition and occurrence
nodes where the host accepts template metadata. Definitions contain fixed fragment
data and `compositionField` children. An occurrence pins the definition ID and
version and has one value carrier. A repeating occurrence gives its collection a
canonical path and stores ordered `compositionItem` children with persistent IDs.
Each item owns its values, so reordering the collection preserves identity and data.

```ts
import {
  compositionComponents,
  createAllocator,
  defineDocumentSchema,
  parseDocument,
  projectComposition,
  toTable,
} from "ml-collab-codec";

const schema = defineDocumentSchema({
  id: "form",
  version: "1",
  rootTag: "form",
  components: {
    ...compositionComponents,
    form: {
      identity: "stable",
      props: { type: "object" },
      content: {
        mode: "element",
        allowedTags: ["compositionDefinition", "compositionOccurrence"],
      },
    },
  },
});

const document = parseDocument(
  '<form id="form"><compositionDefinition id="person" version="1" />' +
    '<compositionOccurrence id="answer" definition="person" version="1" scope="form" /></form>',
  schema,
);
if (!document.ok) throw new Error(JSON.stringify(document.diagnostics));
const [answer] = projectComposition(toTable(document.value, createAllocator()), "answer");
if (answer?.owner !== "answer") throw new Error("Expected the native occurrence as value owner");
```

## Interfaces and ownership

`inferComposition` merges declarations in each named scope. Paths use case-sensitive
ASCII identifier segments separated by dots. Segments can contain hyphens after the
first character. Dots have no escape syntax. The typed path resolves through
`resolveCompositionPath` whether selected from an application suggestion or entered
directly. A request to create an existing path fails. Field row IDs distinguish
structural uses, and labels are display data.

Put JSON Schema contract facts in `contract` on field rows. The compiler merges
object properties recursively, narrows integer and number to integer, intersects
enums, combines inclusive bounds, and requires identical values for other repeated
facts, including defaults. The supported schema keywords are the same as in the
host codec. Compound schemas such as array item contracts and `oneOf` may be used
as a single fact or repeated identically. Arbitrary logical equivalence and general
schema satisfiability are outside the merge algorithm.

Authoring reads the definition and its carriers. Filling edits values under the
occurrence or item row. The result projection reads the same snapshot and identifies
each binding's owner, field, and path for writeback. Missing required inputs are
reported as paths. A conditional field with `when: { path, equals }` depends on an
explicit path in its own scope. Use it for requiredness and to exclude data from
inactive variants. Omitted values, nulls, and defaults follow effective-value
normalization in the projection. False, zero, and empty text are preserved.

Bind a path to a fixed node ID and property, or use `$content` to supply fragment
children. The host's `validateResult` option checks placement, content constraints,
and reference closure of complete results. Use the field's contract for fragment
constraints that must hold even when other fields are incomplete. Each result key
is derived from the occurrence and owner IDs. Fixed fragment IDs are local source
identities and can repeat across projections. Use `copyCompositionFragment` with a
fresh allocator before inserting copies as ordinary host nodes. It remaps structural
IDs and supported schema-declared internal reference keys and preserves external
keys. Reference annotations nested in an opaque schema variant are outside that
copy helper's supported subset.

Install `compositionValidator` with the host schema at authority admission. The
same validator can check an independently opened native document by passing the
table as both candidate and prior state and an empty change list. Tagged source and
JSON retain definitions, occurrences, item identities, and supplied values after
filling. The host may deliberately export a flattened projection.

## Versions and review

Definitions and occurrences carry exact versions. Definitions can also pin host
dependencies by name and exact version. Supply those from a trusted dependency
catalog. A missing or incompatible pin prevents projection and admission when the
validator is installed. The native document remains loadable. A catalog change
requires a new validator and evaluation index. `compositionReviewKey` identifies
the exact definition data, field carriers, and persisted dependencies. A definition
edit changes that key. Store applicable review evidence against this key and the
host profile or policy version. Editing a shared definition affects its dependent
occurrences. The authority checks all of them against the new definition.

`planCompositionRename` renames one path segment under its existing parent. It
updates declaration paths, matching conditions, and values in the selected scope.
It rejects collisions. Scope names, collection mount paths, labels, and
cross-document paths have their own identities and policies.

## Action admission

`planSemanticAction` stages property writes, checks ordered trusted consequence
rules, and exposes the requested and consequent primitives. The caller supplies
the read dependencies and policy version. Write guards are added automatically.
A read can name a top-level property or a node's child order. The planner bounds
commands, rules and captured reads. Rules run once in declared dependency order.
They must be synchronous and deterministic. The engine does not evaluate
document-supplied JavaScript.

Pass the plan to `submitSemanticPlan` to create one guarded transaction. Authority
rebases ordinary primitives, authorizes all transformed writes, compares the
captured reads against the current table, and validates the final candidate before
publishing. Set `authorizeActionReads` on custom authorities serving restricted views.
`RestrictedAuthority` checks guards against its own visibility rules.
A stale plan is rejected even if its rebased writes would produce a valid tree.
Upgrade the authority and collaborators together before using guarded actions.
Older protocol readers reject the added metadata fields.
The request's existing immutable envelope also carries its guards, policy, and
rule names indexed by effect origin ordinal. Published transitions carry effect
attribution and omit the captured read values. Duplicate delivery receives the
recorded decision. Undo and redo transform the accepted effects in current
context. They do not rerun the policy.

## Reproduction and measurements

After `bun run build`, run `node examples/native-templates.mjs`. The four scenarios
exercise a text-bearing participant form, repeated cards, a schedule with a
protected and a stale consequence, and indexed evaluation against a cold rebuild.
The examples use the built public exports and the same authority and client as
other consumers.

On Node 24.22.3, a run with 163 rows, one field, and 160 dependent occurrences
measured 3.8 ms for initial indexed projection, 0.32 ms for requesting all cached
results after an unrelated edit, and 8.84 ms for rebuilding and comparing all
results. These single-process timings exclude I/O. The counters measured one
interface inference and 160 initial evaluations, zero additional evaluations
for an unrelated edit, and one for a changed occurrence. Reordering two cards
reused both projected item objects. The admission validator starts with one full
scan. After that it uses affected rows and scans for dependents when a definition
changes. Changing a shared definition can reevaluate its full fan-out. Walking a
large repeating collection still takes linear time in its item count, even when
each surviving item can reuse its cached result.
