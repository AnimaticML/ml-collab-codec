/**
 * Runnable hidden-hand example (SPEC 13/15, R32): a public table, two private
 * hands, an observer, an authorized atomic "play card" action, projected
 * per-participant events, and a partial participant export.
 * Run with: bun run examples/hidden-hand.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenHandSchema } from "../tests/fixtures/hidden-hand-schema.ts";
import {
  createAllocator,
  fromTable,
  parseDocument,
  RestrictedAuthority,
  serializeDocument,
  toTable,
} from "../src/index.ts";
import { readDocumentFile, writeDocumentFile } from "../src/adapters/file.ts";

async function main(): Promise<void> {
  const source = [
    "<game>",
    '<table id="table1" />',
    '<hand id="handA" owner="alice"><card id="cardA1" rank="Q" suit="spades" /></hand>',
    '<hand id="handB" owner="bob"><card id="cardB1" rank="7" suit="hearts" /></hand>',
    "</game>",
  ].join("");
  const parsed = parseDocument(source, hiddenHandSchema);
  if (!parsed.ok) throw new Error("parse failed");
  const game = new RestrictedAuthority(
    hiddenHandSchema,
    "game-1",
    "epoch-1",
    toTable(parsed.value, createAllocator()),
  );
  game.registerAction("playCard", (table, principal, params, builder) => {
    const cardId = params["cardId"];
    const card = typeof cardId === "string" ? table.get(cardId) : undefined;
    const hand = card === undefined ? undefined : table.get(card.parentId ?? "");
    if (card === undefined || hand?.props["owner"] !== principal) return false;
    builder.moveNode(card.id, "table1", table.get("table1")?.children.length ?? 0);
    return true;
  });

  const cards = (principal: string) =>
    [...game.view(principal).values()].filter((row) => row.tag === "card").map((row) => row.id);
  console.log("observer sees cards:", cards("observer"));
  console.log("alice sees cards:", cards("alice"));
  const denied = game.submitAction(
    "bob",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-bob", seq: 1 },
  );
  console.log(
    "bob playing alice's card:",
    denied.decision.kind === "decided" ? denied.decision.receipt.outcome : denied.decision.kind,
  );
  const played = game.submitAction(
    "alice",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-alice", seq: 1 },
  );
  console.log(
    "alice plays her card:",
    played.decision.kind === "decided" ? played.decision.receipt.outcome : played.decision.kind,
  );
  const observerEvents = JSON.stringify(played.eventsFor("observer"));
  console.log(
    "observer update reveals only the played card:",
    observerEvents.includes("spades") && !observerEvents.includes("hearts"),
  );
  if (!cards("observer").includes("cardA1") || cards("observer").includes("cardB1"))
    throw new Error("visibility broken");

  const partial = game.exportFor("alice");
  const aliceSource = serializeDocument(
    fromTable(
      new Map(partial.rows.map((row) => [row.id, row])),
      hiddenHandSchema.id,
      hiddenHandSchema.version,
    ),
    hiddenHandSchema,
  );
  const path = join(tmpdir(), "hidden-hand-example.doc.txt");
  await writeDocumentFile(path, aliceSource);
  console.log(
    "participant export is partial:",
    partial.partial,
    "and reopens:",
    parseDocument(await readDocumentFile(path), hiddenHandSchema).ok,
  );
  console.log("EXAMPLE_OK");
}

await main();
