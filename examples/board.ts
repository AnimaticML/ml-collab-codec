/**
 * Runnable numeric-board example (SPEC 15, R12/R34): concurrent additive
 * deltas, a drag gesture undone as one group, save, and reopen without a room.
 * Run with: bun run examples/board.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardSchema } from "../tests/fixtures/board-schema.ts";
import {
  createAllocator,
  fromTable,
  parseDocument,
  schemaValidator,
  serializeDocument,
  toTable,
} from "../src/index.ts";
import { readDocumentFile, writeDocumentFile } from "../src/adapters/file.ts";
import { LocalRoom } from "./lib/local-room.ts";

async function main(): Promise<void> {
  const parsed = parseDocument(
    `<board><cell id="c1" value="10" /><cell id="c2" value="0" /></board>`,
    boardSchema,
  );
  if (!parsed.ok) throw new Error("parse failed");
  const room = new LocalRoom(toTable(parsed.value, createAllocator()), {
    validators: [schemaValidator(boardSchema)],
  });
  const alice = room.join("alice");
  const bob = room.join("bob");
  const value = (id: string) => room.authority.getTable().get(id)?.props["value"];

  alice.transact((b) => b.delta("c1", "value", 2));
  bob.transact((b) => b.delta("c1", "value", 3));
  room.settle();
  console.log("c1 after +2 and +3:", value("c1"));

  // A drag gesture: many accepted updates, one undo group.
  alice.beginGroup("drag");
  for (let step = 1; step <= 5; step += 1) {
    alice.transact((b) => b.delta("c2", "value", 1));
    room.settle();
  }
  alice.endGroup();
  bob.transact((b) => b.delta("c2", "value", 100));
  room.settle();
  console.log("c2 after drag + remote:", value("c2"));
  alice.undo();
  room.settle();
  console.log("c2 after undoing the drag:", value("c2"));
  if (value("c1") !== 15 || value("c2") !== 100) throw new Error("unexpected board state");

  const source = serializeDocument(
    fromTable(room.authority.getTable(), boardSchema.id, boardSchema.version),
    boardSchema,
  );
  const path = join(tmpdir(), "board-example.doc.txt");
  await writeDocumentFile(path, source);
  console.log("final:", source);
  console.log("reopened ok:", parseDocument(await readDocumentFile(path), boardSchema).ok);
  console.log("EXAMPLE_OK");
}

await main();
