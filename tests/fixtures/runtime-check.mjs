// Imports the BUILT package (not source) to exercise a representative core
// codec/operation/protocol fixture identically across runtimes (SPEC 15/Q01).
import {
  defineDocumentSchema,
  parseDocument,
  serializeDocument,
  toTable,
  fromTable,
  createAllocator,
  Authority,
  Client,
  SequenceAllocator,
} from "../../dist/index.js";

const schema = defineDocumentSchema({
  id: "runtime-check",
  version: "1.0.0",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: "element", allowedTags: ["p"] },
      props: { type: "object", properties: {}, additionalProperties: false },
    },
    p: {
      identity: "stable",
      content: { mode: "none" },
      props: {
        type: "object",
        properties: { value: { type: "integer", default: 0, "x-additive": true } },
        additionalProperties: false,
      },
    },
  },
});

const parsed = parseDocument(`<doc><p id="c1" value="10" /></doc>`, schema);
if (!parsed.ok) throw new Error("parse failed");
const table = toTable(parsed.value, createAllocator());
const authority = Authority.create("runtime-doc", "epoch-1", table);
const clients = ["replica-a", "replica-b"].map(
  (replica) =>
    new Client({
      documentId: "runtime-doc",
      historyEpoch: "epoch-1",
      allocator: SequenceAllocator.ephemeral(replica),
      actor: replica,
      table,
      revision: 0,
    }),
);
clients[0].transact((b) => b.delta("c1", "value", 2));
clients[1].transact((b) => b.delta("c1", "value", 3));
const events = [];
for (const client of clients) {
  const decision = authority.submit(client.nextRequest(), { actor: client.replica });
  if (decision.kind !== "decided" || decision.receipt.outcome !== "applied")
    throw new Error("delta not applied");
  events.push(decision.transition, decision.receipt);
}
for (const client of clients) client.receive(events);
const printed = serializeDocument(
  fromTable(authority.getTable(), schema.id, schema.version),
  schema,
);
if (printed !== '<doc><p id="c1" value="15" /></doc>')
  throw new Error("unexpected result: " + printed);
for (const client of clients) {
  const view = serializeDocument(
    fromTable(client.getSnapshot().table, schema.id, schema.version),
    schema,
  );
  if (view !== printed) throw new Error("client did not converge: " + view);
}
console.log("RUNTIME_CHECK_OK");
