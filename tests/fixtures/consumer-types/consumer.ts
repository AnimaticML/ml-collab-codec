// Type-level consumer of the built declarations (Q02/R34): a small program
// compiled with tsc against dist/types only, never against src.
import {
  defineDocumentSchema,
  parseDocument,
  type DocumentSchemaDefinition,
  type SchemaProfile,
  Authority,
  Client,
  SequenceAllocator,
  createAllocator,
  mapAnchor,
  toTable,
  type Anchor,
  type AnchorResult,
  type Change,
  type ChangeSummary,
  type DocumentStore,
  type ModelCommit,
  type RequestEnvelope,
  type ServerEvent,
  type Table,
  type UndoResult,
} from "ml-collab-codec";

// A consumer defines its schema as standard JSON Schema 2020-12 plus the documented annotations.
const definition: DocumentSchemaDefinition = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  id: "typed",
  version: "1",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: "mixed" },
      props: {
        type: "object",
        properties: { count: { type: "integer", default: 0, "x-additive": true } },
        additionalProperties: false,
      },
    },
  },
};
const schema: SchemaProfile = defineDocumentSchema(definition);
const parsed = parseDocument("<doc>text</doc>", schema);
if (!parsed.ok) throw new Error("parse failed");
const table: Table = toTable(parsed.value, createAllocator());
const authority = Authority.create("doc", "epoch", table);
const client = new Client({
  documentId: "doc",
  historyEpoch: "epoch",
  allocator: SequenceAllocator.ephemeral("replica-typed"),
  actor: "typed",
  table,
  revision: 0,
});

const observed: string[] = [];
const store: DocumentStore = client;
const stop = store.subscribeCommits((commit: ModelCommit) => {
  const summary: ChangeSummary = commit.changes;
  const mapping: readonly Change[] = commit.mapping;
  const caret: Anchor = { kind: "point", node: "t0", offset: 0, affinity: "before" };
  const mapped: AnchorResult = mapAnchor(caret, mapping);
  observed.push(`${summary.text.length}:${mapped.status}`);
});

client.transact((builder) => builder.textInsert("t0", 0, ">"));
const request: RequestEnvelope | undefined = client.nextRequest();
if (request !== undefined) {
  const decision = authority.submit(request, { actor: "typed" });
  if (decision.kind === "decided") {
    const events: ServerEvent[] =
      decision.transition === undefined
        ? [decision.receipt]
        : [decision.transition, decision.receipt];
    client.receive(events);
  }
}
const undo: UndoResult["status"] = client.undo().status;
observed.push(undo);
stop();
