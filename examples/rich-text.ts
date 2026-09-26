/**
 * Runnable rich-text example (SPEC 15, R34): schema -> source -> free and
 * addressed editing -> diff -> concurrent application -> collaborative undo
 * -> save -> reopen without a room. Run with: bun run examples/rich-text.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { richTextSchema } from "../tests/fixtures/rich-text-schema.ts";
import {
  createAllocator,
  fromTable,
  parseDocument,
  proposeEdit,
  rebaseProposal,
  serializeDocument,
  toTable,
  wrapText,
} from "../src/index.ts";
import { readDocumentFile, writeDocumentFile } from "../src/adapters/file.ts";
import { LocalRoom } from "./lib/local-room.ts";

async function main(): Promise<void> {
  const parsed = parseDocument(`<doc><p id="p1">Payment in 10 days.</p></doc>`, richTextSchema);
  if (!parsed.ok) throw new Error("base parse failed");
  const base = toTable(parsed.value, createAllocator());
  const run = base.get("p1")?.children[0] ?? "";
  const print = () =>
    serializeDocument(
      fromTable(room.authority.getTable(), richTextSchema.id, richTextSchema.version),
      richTextSchema,
    );

  const room = new LocalRoom(base);
  const human = room.join("human");
  const editor = room.join("editor");
  // Concurrent structural and text edits of the same original text: both survive.
  editor.transact((b) => void wrapText(b, run, 11, 13, { tag: "emphasis" }));
  human.transact((b) => b.textReplace(run, 11, 13, "15"));
  room.settle();
  console.log("after wrap + replace:", print());

  // A free agent edit of the read base is rebased over accepted work, never diffed against C.
  const agent = parseDocument(
    `<doc><p id="p1">Payment in 10 working days.</p></doc>`,
    richTextSchema,
  );
  if (!agent.ok) throw new Error("agent parse failed");
  const proposal = proposeEdit({ table: base, revision: 0 }, agent.value.root, {
    replica: "replica-agent",
    seq: 1,
  });
  const rebased = rebaseProposal(proposal, room.authority);
  if (rebased.status !== "rebased") throw new Error(`proposal ${rebased.status}`);
  const agentClient = room.join("agent");
  agentClient.transact((b) => rebased.changes.forEach((change) => b.record(change)));
  room.settle();
  console.log("after agent proposal:", print());

  // Collaborative undo of the editor's wrap keeps everyone else's work.
  console.log("undo wrap:", editor.undo().status);
  room.settle();
  const final = print();
  console.log("final:", final);
  if (final !== '<doc><p id="p1">Payment in 15 working days.</p></doc>')
    throw new Error("unexpected result");

  const path = join(tmpdir(), "rich-text-example.doc.txt");
  await writeDocumentFile(path, final);
  console.log(
    "reopened without a room:",
    parseDocument(await readDocumentFile(path), richTextSchema).ok,
  );
  console.log("EXAMPLE_OK");
}

await main();
