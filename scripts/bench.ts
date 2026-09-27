/**
 * Benchmarks on Word-like documents (about 20 paragraphs per page, inline
 * emphasis, a 4x5 table every ~3 pages) under the shipping guarantees: a
 * schema-backed authority (final-candidate validation on every admission),
 * clients with real history maintenance, copy-on-acquisition ownership, and
 * runtime invalidation through the derived graph. Each figure is the median
 * and p95 of repeated samples after warm-up, in milliseconds on this
 * machine. Results go to stdout and reports/benchmarks.md. They are evidence
 * for the recorded environment, not a guarantee and not a CI gate.
 *
 * Run with `bun run bench` (BENCH_QUICK=1 for a small smoke run).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Authority,
  ChangeBuilder,
  Client,
  CONTROL_PROFILE,
  DerivedGraph,
  OPERATION_FORMAT,
  SequenceAllocator,
  createAllocator,
  defineDocumentSchema,
  fromTable,
  parseDocument,
  proposeEdit,
  serializeDocument,
  toTable,
  validateTable,
} from "../src/index.ts";
import type { Change, ContentItem, Table } from "../src/index.ts";

const QUICK = process.env["BENCH_QUICK"] === "1";
const SAMPLES = QUICK ? 5 : 30;
const WARMUP = QUICK ? 1 : 5;
const closed = { type: "object", properties: {}, additionalProperties: false } as const;

const schema = defineDocumentSchema({
  id: "bench.word",
  version: "1",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: "element", allowedTags: ["p", "table"] },
      props: closed,
    },
    p: {
      identity: "stable",
      content: { mode: "mixed", allowedTags: ["em"] },
      props: {
        type: "object",
        properties: { x: { type: "integer" } },
        additionalProperties: false,
      },
    },
    em: { identity: "none", content: { mode: "mixed" }, props: closed },
    table: {
      identity: "stable",
      content: { mode: "element", allowedTags: ["row"] },
      props: closed,
    },
    row: { identity: "none", content: { mode: "element", allowedTags: ["cell"] }, props: closed },
    cell: { identity: "none", content: { mode: "mixed" }, props: closed },
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
    const rows = Array.from({ length: 5 }, (_, r) => ({
      tag: "row",
      props: {},
      content: cells(r),
    }));
    return { tag: "table", id: `table${i}`, props: {}, content: rows };
  }
  const emphasis = { tag: "em", props: {}, content: ["emphasised words"] };
  return {
    tag: "p",
    id: `p${i}`,
    props: {},
    content: [words.slice(0, 60), emphasis, words.slice(0, 70)],
  };
}

function document(pages: number, longText = 0): Table {
  const content = Array.from({ length: pages * 20 }, (_, i) => block(i));
  if (longText > 0) content[1] = { tag: "p", id: "p1", props: {}, content: ["x".repeat(longText)] };
  return toTable(
    {
      schemaId: schema.id,
      schemaVersion: schema.version,
      root: { tag: "doc", props: {}, content },
    },
    createAllocator(),
  );
}

/** Median and p95 of repeated samples (after warm-up) of `work`, in ms. */
function measure(work: () => void): { median: number; p95: number } {
  for (let i = 0; i < WARMUP; i += 1) work();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    work();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95) };
}

const envelope = (
  replica: string,
  seq: number,
  baseRevision: number,
  changes: readonly Change[],
): unknown => ({
  profile: CONTROL_PROFILE,
  opFormat: OPERATION_FORMAT,
  documentId: "d",
  historyEpoch: "e",
  replica,
  seq,
  baseRevision,
  changes,
  meta: {},
});

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

const firstRun = (table: Table, id: string): string => table.get(id)?.children[0] ?? "";

type Row = Record<string, { median: number; p95: number } | number | string>;

/** Editing costs on one document size, with validation and history enabled. */
function editing(pages: number): Row {
  const table = document(pages);
  const run = firstRun(table, "p10");
  const client = newClient(table, "typist");
  const keystroke = measure(() => void client.transact((b) => b.textInsert(run, 0, "x")));
  const authority = Authority.create("d", "e", table, { schema });
  let seq = 0;
  let applied = 0;
  const admit = (build: (b: ChangeBuilder) => void) => () => {
    seq += 1;
    const b = new ChangeBuilder(authority.getTable(), { replica: "s", seq });
    build(b);
    const decision = authority.submit(envelope("s", seq, authority.getRevision(), b.changes), {
      actor: "s",
    });
    if (decision.kind === "decided" && decision.receipt.outcome === "applied") applied += 1;
  };
  const admitKeystroke = measure(
    admit((b) => b.textInsert(firstRun(authority.getTable(), "p10"), 0, "x")),
  );
  let n = 0;
  const admitParagraph = measure(
    admit(
      (b) =>
        void b.insertNode("$root", pages * 10, {
          tag: "p",
          id: `new${(n += 1)}`,
          props: {},
          children: ["new"],
        }),
    ),
  );
  const admitMove = measure(admit((b) => b.moveNode("p20", "$root", (n += 1) % 2 === 0 ? 0 : 40)));
  const admitSplit = measure(admit((b) => void b.split(firstRun(authority.getTable(), "p30"), 5)));
  // Runtime invalidation: one derivation per paragraph; a keystroke invalidates one of them.
  const graph = new DerivedGraph(table);
  for (const id of [...table.keys()].filter((k) => table.get(k)?.tag === "p"))
    graph.define(`len:${id}`, (ctx) => ctx.children(id).map((r) => ctx.text(r).length));
  graph.flush();
  let current = table;
  const runtime = measure(() => {
    const b = new ChangeBuilder(current, { replica: "g", seq: 1 });
    b.textInsert(run, 0, "y");
    current = b.current();
    graph.update(current, {
      candidates: [run],
      created: [],
      deleted: [],
      props: [],
      text: [run],
      children: [],
      moved: [],
      retagged: [],
    });
    graph.flush();
  });
  return {
    pages,
    rows: table.size,
    keystroke,
    admitKeystroke,
    admitParagraph,
    admitMove,
    admitSplit,
    runtime,
    recovery: recovery(table),
    applied: `${applied}/${seq}`,
  };
}

/** Rejection of an in-flight request with 20 dependent pending edits behind it (one sample). */
function recovery(table: Table): number {
  const run = firstRun(table, "p10");
  const room = Authority.create("d", "e", table, { schema });
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

/** Whole-document costs (full scans by design): save, open, table build, validation, agent diff. */
function loading(pages: number): Row {
  const model = fromTable(document(pages), schema.id, schema.version);
  const source = serializeDocument(model, schema);
  const table = toTable(model, createAllocator());
  const edited = parseDocument(source.replace("sit amet", "SIT AMET"), schema);
  if (!edited.ok) throw new Error("benchmark document failed to parse");
  return {
    pages,
    sourceKB: Math.round(source.length / 1024),
    serialize: measure(() => void serializeDocument(model, schema)),
    parse: measure(() => void parseDocument(source, schema)),
    toTable: measure(() => void toTable(model, createAllocator())),
    fullValidation: measure(() => void validateTable(table, schema)),
    agentProposal: measure(
      () =>
        void proposeEdit({ table, revision: 0 }, edited.value.root, { replica: "agent", seq: 1 }),
    ),
  };
}

/** Keystrokes into one very long run: the text is one string, so each edit costs O(run length). */
function longText(length: number): Row {
  const table = document(QUICK ? 1 : 30, length);
  const client = newClient(table, "typist");
  const run = firstRun(table, "p1");
  return {
    runLength: length,
    keystroke: measure(() => void client.transact((b) => b.textInsert(run, 0, "x"))),
  };
}

const cell = (value: Row[string]): string =>
  typeof value === "object"
    ? `${value.median.toFixed(3)} / ${value.p95.toFixed(3)}`
    : String(typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : value);

function table(rows: readonly Row[]): string[] {
  const keys = Object.keys(rows[0] ?? {});
  return [
    `| ${keys.join(" | ")} |`,
    `| ${keys.map(() => "---:").join(" | ")} |`,
    ...rows.map((row) => `| ${keys.map((k) => cell(row[k] ?? "")).join(" | ")} |`),
  ];
}

const sizes = QUICK ? [2] : [30, 100, 300, 500];
const environment = `Bun ${Bun.version}, ${platform()}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads); ${SAMPLES} samples after ${WARMUP} warm-up runs; cells are median / p95 in ms unless labelled`;
const lines = [
  "# Benchmarks",
  "",
  `Generated by \`bun run bench\` on ${new Date().toISOString().slice(0, 10)}. ${environment}.`,
  "Schema validation, history, and copy-on-acquisition are on in every measurement.",
  "",
  "## Edits (schema-backed authority, client with history)",
  "",
  ...table(sizes.map(editing)),
  "",
  "`keystroke`: client transact (local publication and history); `admit*`: authority decision",
  "including rebase, final-candidate schema validation, and ledger; `runtime`: derived-graph",
  "update and flush after a keystroke with one derivation per paragraph; `recovery`: one",
  "rejection with 20 dependent pending edits (single sample, ms); `applied`: admissions measured",
  "that the schema-backed authority actually applied.",
  "",
  "## Whole-document operations (full scans by design)",
  "",
  ...table(sizes.filter((p) => p !== 300).map(loading)),
  "",
  "## Long text runs",
  "",
  ...table((QUICK ? [1000] : [1000, 50_000, 500_000]).map(longText)),
  "",
  "Remaining full scans: parse, serialize, `toTable`, full validation (join, checkpoint",
  "import, provider decode), and whole-document proposals are linear in document size.",
  "A text run is one string, so a keystroke inside a very long run is linear in that run.",
];
console.log(lines.join("\n"));
if (!QUICK) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(resolve(root, "reports"), { recursive: true });
  await writeFile(resolve(root, "reports/benchmarks.md"), lines.join("\n") + "\n");
}
