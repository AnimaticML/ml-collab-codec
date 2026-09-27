# Operations

Every edit is a list of self-contained reversible primitives (operation format
`sdl.ops/2`, `OPERATION_FORMAT`). A record carries everything needed to apply, check, and
invert it — before-values and removed payloads double as preconditions — plus a stable
`origin { replica, seq, ordinal }` that identifies the contribution through rebasing and
undo. Nothing needs a snapshot or history to invert.

## The primitives

Coordinates: text offsets count Unicode code points; array indexes count occurrences
(equal values are distinct occurrences); child indexes count all children, including text
runs. A `gap` is an insertion point in the list as it is before the primitive applies.

| Kind          | Fields                                       | Effect                                                   | Inverse                         |
| ------------- | -------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `set`         | `node, path, before?, after?`                | set or remove (absent `after`) a value at a prop path    | `set` with before/after swapped |
| `delta`       | `node, path, by`                             | add a safe integer to an `x-additive` integer field      | `delta` with `-by`              |
| `arrayInsert` | `node, path, index, values`                  | insert occurrences                                       | `arrayDelete` of the same       |
| `arrayDelete` | `node, path, index, values`                  | remove occurrences (the removed values are checked)      | `arrayInsert` of the same       |
| `arrayMove`   | `node, path, from, gap`                      | move one occurrence                                      | the reverse move                |
| `textInsert`  | `node, offset, text`                         | insert text into a run                                   | `textDelete`                    |
| `textDelete`  | `node, offset, text`                         | delete text (the removed text is checked)                | `textInsert`                    |
| `nodeInsert`  | `parent, index, subtree`                     | insert a complete subtree (ids, tags, props, children)   | `nodeDelete`                    |
| `nodeDelete`  | `parent, index, subtree`                     | delete a subtree (the whole removed payload is recorded) | `nodeInsert`                    |
| `nodeMove`    | `node, fromParent, fromIndex, toParent, gap` | move a node, keeping its identity                        | the reverse move                |
| `split`       | `node, other, offset, parent, index`         | cut a run; the tail becomes run `other` at `index + 1`   | `merge`                         |
| `merge`       | `node, other, offset, parent, index`         | join run `other` onto `node` at `offset`                 | `split`                         |
| `setTag`      | `node, before, after`                        | change a node's type, keeping its identity and children  | `setTag` swapped                |

`CHANGE_KINDS` lists the kinds; `decodeChanges` validates records from untrusted JSON
(unknown kinds, malformed fields, identity retags, and more than 10,000 records are
rejected); `applyChanges` applies atomically (all or nothing, `ApplyError` with a code);
`invertChanges` inverts a sequence.

## Building changes

`ChangeBuilder` authors complete records against the current staged state and applies each
command so later commands see it. Inputs (values, inserted props) are copied on
acquisition.

```ts
import assert from "node:assert/strict";
import {
  applyChanges,
  ChangeBuilder,
  createAllocator,
  decodeChanges,
  fromTable,
  invertChanges,
  ROOT_ID,
  textOf,
  toTable,
  wrapText,
} from "ml-collab-codec";

const table = toTable(
  {
    schemaId: "example",
    schemaVersion: "1",
    root: {
      tag: "doc",
      props: { tags: ["a", "a", "b"], count: 1 },
      content: [{ id: "p1", tag: "p", props: {}, content: ["Payment in 10 days."] }],
    },
  },
  createAllocator(),
);
const run = table.get("p1")?.children[0] ?? "";

const b = new ChangeBuilder(table, { replica: "replica-a", seq: 1 });
b.textReplace(run, 11, 13, "15"); // "10" → "15"
b.arrayDelete(ROOT_ID, ["tags"], 1); // the second "a", by occurrence, not by value
b.delta(ROOT_ID, ["count"], 2);
wrapText(b, run, 0, 7, { tag: "strong" }); // split + insert + identity-preserving move
b.setTag("p1", "h1");
const after = applyChanges(table, b.changes);

assert.equal(after.get("p1")?.tag, "h1");
assert.deepEqual(after.get(ROOT_ID)?.props, { tags: ["a", "b"], count: 3 });
assert.deepEqual(fromTable(after, "example", "1").root.content?.[0], {
  id: "p1",
  tag: "h1",
  props: {},
  content: [{ tag: "strong", props: {}, content: ["Payment"] }, " in 15 days."],
});
assert.equal(textOf(after.get(run)), "");

// Records are JSON: decode them from the wire and invert them without any other state.
const wire = decodeChanges(JSON.parse(JSON.stringify(b.changes)));
assert.deepEqual(
  fromTable(applyChanges(after, invertChanges(wire)), "example", "1"),
  fromTable(table, "example", "1"),
);
```

Rich-text helpers compile into primitives: `wrapText`, `unwrap`, `splitContainer`,
`mergeContainers`, and `findOccurrence` (an array occurrence by value with an explicit
ambiguity result).

## Concurrent edits: transformation and conflicts

`transformPair(a, b)` rewrites two concurrent changes formed in the same context so both
orders converge (`apply(apply(S, a), b') = apply(apply(S, b), a')`); `rebase(a, history)`
moves a change over accepted transitions. The rules (SPEC §18.4):

- Sequences map positions through the other side's edit. An insertion inside a
  concurrently deleted range survives and the deletion splits around it (`abcd`: delete
  `bc` versus insert `X` at 2 gives `aXd`).
- Same-gap insertions (text, array values, nodes, move destinations) order by stable origin
  `(replica, seq, ordinal)`. Text inserted exactly at a concurrent split point stays on the
  left run; a split continuation stays glued to its run.
- Edits addressed to a run that a concurrent `merge` absorbs (text edits, a split, or a
  further merge) follow its text into the surviving run.
- Equal concurrent `set`s, deletions, moves, and retags become no-ops (`alreadySatisfied`).
  Insertions and deltas are separate contributions and both apply.
- These are conflicts — the newer side is rejected, never silently merged: different
  values for one field; `set` versus `delta` on it; a value write versus a write inside or
  around it; removal of an array occurrence another change edits or moves; any change that
  needs a node the other destroyed (and deletion of a subtree the other edited); moves of
  one node (or occurrence) to different places; different retags of one node; moving or
  deleting a run that is concurrently split or merged; inserting between two runs that are
  concurrently merged.
- Moves that together would form a cycle are refused when the candidate is applied.

```ts
import assert from "node:assert/strict";
import {
  applyChanges,
  ChangeBuilder,
  createAllocator,
  isConflict,
  textOf,
  toTable,
  transformPair,
} from "ml-collab-codec";

const base = toTable(
  {
    schemaId: "x",
    schemaVersion: "1",
    root: { tag: "doc", props: { title: "t" }, content: ["abcd"] },
  },
  createAllocator(),
);
const run = base.get("$root")?.children[0] ?? "";
const del = new ChangeBuilder(base, { replica: "a", seq: 1 }).textDelete(run, 1, 2).changes;
const ins = new ChangeBuilder(base, { replica: "b", seq: 1 }).textInsert(run, 2, "X").changes;
const pair = transformPair(del, ins);
assert.ok(!isConflict(pair));
assert.equal(textOf(applyChanges(applyChanges(base, del), pair.b).get(run)), "aXd");
assert.equal(textOf(applyChanges(applyChanges(base, ins), pair.a).get(run)), "aXd");

const one = new ChangeBuilder(base, { replica: "a", seq: 2 }).set("$root", "title", "A").changes;
const two = new ChangeBuilder(base, { replica: "b", seq: 2 }).set("$root", "title", "B").changes;
assert.deepEqual(transformPair(one, two), {
  conflict: "concurrentWrite",
  detail: "concurrent writes to the same field",
});
```

The exhaustive evidence is the pair matrix (all 13×13 ordered kind pairs, both origin
precedences) in `reports/ot-pair-coverage.md`.
