import { hiddenHandSchema } from "../fixtures/hidden-hand-schema.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { createAllocator, toTable } from "../../src/core/table.ts";
import { RestrictedAuthority } from "../../src/core/visibility.ts";
import { DOC, EPOCH } from "./room.ts";

/** Public table, two private hands (alice, bob), and an observer; `bobRank` varies the hidden secret. */
export function setupGame(bobRank = "7"): RestrictedAuthority {
  const source = [
    "<game>",
    '<table id="table1" />',
    '<hand id="handA" owner="alice"><card id="cardA1" rank="Q" suit="spades" /></hand>',
    `<hand id="handB" owner="bob"><card id="cardB1" rank="${bobRank}" suit="hearts" /></hand>`,
    "</game>",
  ].join("");
  const parsed = parseDocument(source, hiddenHandSchema);
  if (!parsed.ok) throw new Error("fixture parse failed");
  const game = new RestrictedAuthority(
    hiddenHandSchema,
    DOC,
    EPOCH,
    toTable(parsed.value, createAllocator()),
  );
  // Trusted application action: rights are checked against current state at commit time.
  game.registerAction("playCard", (table, principal, params, builder) => {
    const cardId = params["cardId"];
    if (typeof cardId !== "string") return false;
    const card = table.get(cardId);
    const hand = card === undefined ? undefined : table.get(card.parentId ?? "");
    if (hand === undefined || hand.props["owner"] !== principal) return false;
    builder.moveNode(cardId, "table1", table.get("table1")?.children.length ?? 0);
    return true;
  });
  return game;
}
