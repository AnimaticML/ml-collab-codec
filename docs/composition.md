# Composing and extending a document

Run the two headless consumers against the built package.

```sh
bun run build
node examples/interview-composition.mjs
node examples/tabletop-evolution.mjs
```

## Static composition decision record

The interview example assembles the `interview-world` and `animatic-camera` declarations
into an `interview@1` host profile. Both use declaration and implementation version
`1.0.0`. The host owns the component tag namespace, rejects duplicate tags, defines
allowed nesting and checks exact version pins. The world contains two stable people.
Both ml-animatic occurrence nodes reference the same world key and each stores its own
camera values.

Use a definition and reference pair for the shared key when the schema should reject
dangling references. The same declarations validate source and JSON imports.

```ts
import { defineDocumentSchema, parseDocument } from "ml-collab-codec";

const profile = defineDocumentSchema({
  id: "shot",
  version: "1",
  rootTag: "scene",
  components: {
    scene: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["world", "occurrence"] },
      props: { type: "object", additionalProperties: false },
    },
    world: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { key: { type: "string", "x-reference": "definition" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
    occurrence: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { world: { type: "string", "x-reference": "reference" } },
        required: ["world"],
        additionalProperties: false,
      },
    },
  },
});
const parsed = parseDocument(
  '<scene id="s"><world id="w" key="set"/><occurrence id="shot" world="set"/><occurrence id="reverse" world="set"/></scene>',
  profile,
);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
```

| Outcome                                                        | Classification          | Evidence                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared world key, stable IDs and independent camera properties | Already supported       | Source and JSON reopen with the same world, people and occurrence IDs and values. A dangling reference is rejected.                                                                                                                                    |
| Declaration assembly, naming, version matching and nesting     | Consumer responsibility | The host owns the tag namespace and version pins. It rejects duplicate definitions and compiles one profile with explicit allowed children.                                                                                                            |
| Atomic camera action and direct edit                           | Already supported       | Alice changes two fields in one authority revision. Bob directly changes the reverse shot. The trusted host invariant rejects a reversed camera range.                                                                                                 |
| Own-group undo                                                 | Already supported       | Alice's undo and Bob's edit enter the same authority history. Alice's camera values revert while Bob's far plane stays at 22.                                                                                                                          |
| Reopen without camera behavior                                 | Consumer responsibility | The host keeps compatible declarations and validators. Source data survives and direct, validated edits still work. The camera action requires the exact installed implementation. Source and JSON reopen start a fresh history epoch in this example. |

The example demonstrates no codec gap. The application owns behavior loading. The
same document authority admits edits to both the shared world and its occurrences.
Source and JSON exports carry content and dependency pins. Use checkpoints when the
application also needs to preserve authority scope and history.

## Live addition lifecycle decision record

The tabletop example starts with a running game at round 7 and a basic card. The host
uses a stable `tabletop@1` storage profile that preserves extension data. A trusted
candidate validator selects a strict profile from the **exact** dependency pin in the
final candidate. Profiles and JavaScript behavior come from installed catalog entries.
The pin contains a name, declaration version and implementation version. It carries
no executable code. In this fixture the trusted entries are local JavaScript objects.
A real host must give those pins immutable meaning and control who can install entries.

| Lifecycle step                    | Decision and observed result                                                                                                                                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and admit                 | Install `charge-card` declaration and implementation `1.0.0` in the authority and both client catalogs. The authority rejects a missing entry and an incompatible implementation. One accepted request records the pin and inserts `charge-1` with three charges.                                                          |
| Keep editing                      | Bob prepares a title change on the old revision. It survives the addition. The JavaScript spend action resolves the exact module against the client's visible pin and persists the new charge count through a normal transaction. The authority validates the resulting state independently.                               |
| Undo or remove                    | Before dependent edits, Alice can undo the whole installation and redo it. The concurrent title survives. After Bob spends a charge, Alice's targeted undo reports a conflict. Removing just the dependency while its instance remains is rejected by the strict base profile.                                             |
| Save and reopen                   | The checkpoint preserves authority scope, revision and retained transitions. The host supplies the validator again on restore. Tagged source retains the pin, instance, charge count, round, title and original card. With the expected entry installed, a new client validates the snapshot and can spend another charge. |
| Missing or incompatible on reopen | The storage profile can still read the pinned state and preserve unknown component data. The example blocks an editing session and the spend action when the required entry is missing or incompatible.                                                                                                                    |

The bounded proof covers a single additive installation and a state-only domain action.
The document stores pins and resulting values. Runtime catalogs, caches and transient
simulation are rebuilt by the host. The example performs no external effects.
Collaborative undo applies to admitted document changes. The owner must define
compensation separately for any external effects.

The application owner still needs to decide how gameplay state migrates between
versions and what to do with dependent instances during replacement or removal.
Shell owns trusted installation, catalog agreement across collaborators, and the
loading and admission policy when a client lacks a version. The prototype uses
explicitly synchronized in-process catalogs. It leaves production distribution,
incompatible replacement and migration across existing history untested. The
supported path uses current codec contracts and calls for no codec change.
