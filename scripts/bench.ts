/**
 * Performance benchmark on Word-like documents (about 20 paragraphs per page,
 * inline emphasis, a 4x5 table every ~3 pages, flat body). Prints ms per
 * operation for typical (30), large (100), and maximum (300-500) page counts.
 * Run with: bun run bench. Timings are machine-dependent evidence, not a gate.
 */
import {
  Authority,
  ChangeBuilder,
  Client,
  SequenceAllocator,
  applyChanges,
  createAllocator,
  fromTable,
  parseDocument,
  proposeEdit,
  registerSchema,
  serializeDocument,
  toTable,
} from "../src/index.ts";
import type { ContentItem, Table } from "../src/index.ts";

const schema = registerSchema({
  id: "bench.word",
  version: "1",
  rootTag: "doc",
  unknownPolicy: "error",
  components: {
    doc: {
      tag: "doc",
      identity: "none",
      properties: {},
      content: { mode: "element", allowedTags: ["p", "table"] },
    },
    p: {
      tag: "p",
      identity: "stable",
      properties: { x: { type: "number" } },
      content: { mode: "mixed", allowedTags: ["em"] },
    },
    em: { tag: "em", identity: "none", properties: {}, content: { mode: "mixed" } },
    table: {
      tag: "table",
      identity: "stable",
      properties: {},
      content: { mode: "element", allowedTags: ["row"] },
    },
    row: {
      tag: "row",
      identity: "none",
      properties: {},
      content: { mode: "element", allowedTags: ["cell"] },
    },
    cell: { tag: "cell", identity: "none", properties: {}, content: { mode: "mixed" } },
  },
});

const words =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(3);

function block(i: number): ContentItem {
  if (i % 60 === 59) {
    const cells = (r: number) =>
      Array.from({ length: 4 }, (_, c) => ({
        tag: "cell",
        props: {},
        content: [`cell ${r}.${c}`],
      }));
    return {
      tag: "table",
      id: `table${i}`,
      props: {},
      content: Array.from({ length: 5 }, (_, r) => ({ tag: "row", props: {}, content: cells(r) })),
    };
  }
  const emphasis = { tag: "em", props: {}, content: ["emphasised words"] };
  return {
    tag: "p",
    id: `p${i}`,
    props: {},
    content: [words.slice(0, 60), emphasis, words.slice(0, 70)],
  };
}

function document(pages: number): Table {
  const content = Array.from({ length: pages * 20 }, (_, i) => block(i));
  return toTable(
    {
      schemaId: schema.id,
      schemaVersion: schema.version,
      root: { tag: "doc", props: {}, content },
    },
    createAllocator(),
  );
}

function perOp(runs: number, work: () => void): number {
  work();
  const started = performance.now();
  for (let i = 0; i < runs; i += 1) work();
  return (performance.now() - started) / runs;
}

function envelope(replica: string, seq: number, baseRevision: number, changes: unknown): unknown {
  return {
    profile: "sdl.scalar-prefix/1",
    opFormat: "sdl.ops/1",
    documentId: "d",
    historyEpoch: "e",
    replica,
    seq,
    baseRevision,
    changes,
    meta: {},
  };
}

function newClient(table: Table, replica: string): Client {
  return new Client({
    documentId: "d",
    historyEpoch: "e",
    allocator: SequenceAllocator.ephemeral(replica),
    actor: replica,
    table,
    revision: 0,
  });
}

/** Time one rejection of an in-flight request with 20 dependent pending edits behind it. */
function recovery(table: Table, run: string): number {
  const room = Authority.create("d", "e", table);
  const client = newClient(table, "client");
  client.transact((b) => b.set("p1", "x", 1));
  for (let i = 0; i < 20; i += 1) {
    client.closeGroup();
    client.transact((b) => b.textInsert(run, 0, "z"));
  }
  room.submit(
    envelope(
      "rival",
      1,
      0,
      new ChangeBuilder(table, { replica: "rival", seq: 1 }).set("p1", "x", 2).changes,
    ),
    { actor: "rival" },
  );
  const decision = room.submit(client.nextRequest(), { actor: "client" });
  if (decision.kind !== "decided") throw new Error("unexpected resync");
  const started = performance.now();
  client.receive([...(room.transitionsSince(0) ?? []), decision.receipt]);
  return performance.now() - started;
}

function editing(pages: number): string {
  const table = document(pages);
  const run = table.get("p10")?.children[0] ?? "";
  const keystroke = new ChangeBuilder(table, { replica: "r", seq: 1 }).textInsert(
    run,
    0,
    "x",
  ).changes;
  const apply = perOp(40, () => applyChanges(table, keystroke));
  const client = newClient(table, "typist");
  const local = perOp(40, () => client.transact((b) => b.textInsert(run, 0, "x")));
  const authority = Authority.create("d", "e", table);
  let seq = 0;
  const admit = perOp(20, () => {
    seq += 1;
    const changes = new ChangeBuilder(authority.getTable(), { replica: "s", seq }).textInsert(
      run,
      0,
      "x",
    ).changes;
    authority.submit(envelope("s", seq, authority.getRevision(), changes), { actor: "s" });
  });
  const builder = new ChangeBuilder(table, { replica: "r", seq: 2 });
  builder.insertNode("$root", pages * 10, { tag: "p", props: {}, children: ["new"] });
  const paragraph = perOp(20, () => applyChanges(table, builder.changes));
  const cells = [apply, local, admit, paragraph].map((ms) => `${ms.toFixed(3).padStart(8)} ms`);
  return `${String(pages).padStart(5)} ${String(table.size).padStart(6)} | ${cells.join(" | ")} | ${recovery(table, run).toFixed(1).padStart(6)} ms`;
}

function loading(pages: number): string {
  const model = fromTable(document(pages), schema.id, schema.version);
  const source = serializeDocument(model, schema);
  const save = perOp(5, () => serializeDocument(model, schema));
  const open = perOp(5, () => parseDocument(source, schema));
  const build = perOp(5, () => toTable(model, createAllocator()));
  const table = toTable(model, createAllocator());
  const edited = parseDocument(source.replace("sit amet", "SIT AMET"), schema);
  if (!edited.ok) throw new Error("benchmark document failed to parse");
  const proposal = perOp(5, () =>
    proposeEdit({ table, revision: 0 }, edited.value.root, { replica: "agent", seq: 1 }),
  );
  const cells = [save, open, build, proposal].map((ms) => `${ms.toFixed(1).padStart(6)} ms`);
  return `${String(pages).padStart(5)} | ${cells.join(" | ")} | ${(source.length / 1024).toFixed(0)} KB`;
}

console.log(
  "pages   rows | keystroke apply | client keystroke | server admit | insert paragraph | recovery (20 pending)",
);
for (const pages of [30, 100, 300, 500]) console.log(editing(pages));
console.log("\npages | serialize | parse | toTable | agent whole-doc proposal | source size");
for (const pages of [30, 100, 500]) console.log(loading(pages));
