import { describe, expect, test } from "bun:test";
import { Client } from "../../src/core/client.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import type { RestrictedAuthority } from "../../src/core/visibility.ts";
import { setupGame } from "../support/game.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";

/** A participant client working on its authorized projection, connected through the restricted authority. */
function participant(
  game: RestrictedAuthority,
  actor: string,
): { client: Client; flush: () => string[] } {
  const client = new Client({
    documentId: DOC,
    historyEpoch: EPOCH,
    allocator: SequenceAllocator.ephemeral(`replica-${actor}`),
    actor,
    table: game.view(actor),
    revision: game.authority.getRevision(),
  });
  const seen: string[] = [];
  const flush = (): string[] => {
    for (
      let request = client.nextRequest();
      request !== undefined;
      request = client.nextRequest()
    ) {
      const events = game.submit(request, { actor }).eventsFor(actor);
      seen.push(JSON.stringify(events));
      client.receive(events);
    }
    return seen;
  };
  return { client, flush };
}

function stream(game: RestrictedAuthority, secret: string): { alice: string; observer: string } {
  const out = { alice: [] as string[], observer: [] as string[] };
  const record = (decision: ReturnType<RestrictedAuthority["submit"]>) => {
    out.alice.push(JSON.stringify(decision.eventsFor("alice")));
    out.observer.push(JSON.stringify(decision.eventsFor("observer")));
  };
  const table = game.fullView();
  record(
    game.submit(
      envelope(
        "replica-bob",
        1,
        0,
        build(table, "replica-bob", 1, (b) => b.set("cardB1", "rank", secret)),
      ),
      { actor: "bob" },
    ),
  );
  record(
    game.submit(
      envelope(
        "replica-bob",
        2,
        1,
        build(game.fullView(), "replica-bob", 2, (b) => b.deleteNode("cardB1")),
      ),
      { actor: "bob" },
    ),
  );
  record(
    game.submit(
      envelope(
        "replica-bob",
        3,
        2,
        build(game.fullView(), "replica-bob", 3, (b) => b.set("cardA1", "rank", secret)),
      ),
      { actor: "bob" },
    ),
  );
  return { alice: out.alice.join("\n"), observer: out.observer.join("\n") };
}

describe("R32 history additions preserve restricted-region safety", () => {
  test("R32 History additions preserve restricted-region safety", () => {
    // Deleted private values, inverse payloads, and rejection receipts stay inside bob's region.
    const [first, second] = [stream(setupGame("7"), "9"), stream(setupGame("K"), "J")];
    expect(first).toEqual(second);
    for (const text of [first.alice, first.observer]) {
      for (const secret of ["hearts", '"7"', '"9"', "cardB1"]) expect(text).not.toContain(secret);
    }

    // Alice edits and undoes her own private card through the authorized-region path.
    const game = setupGame();
    const alice = participant(game, "alice");
    const bobEvents: string[] = [];
    alice.client.transact((b) => b.set("cardA1", "rank", "K"));
    const edit = alice.flush();
    expect(game.fullView().get("cardA1")?.props["rank"]).toBe("K");
    expect(alice.client.undo().status).toBe("requested");
    const undoRequest = alice.client.nextRequest();
    const undo = game.submit(undoRequest, { actor: "alice" });
    alice.client.receive(undo.eventsFor("alice"));
    bobEvents.push(JSON.stringify(undo.eventsFor("bob")));
    expect(game.fullView().get("cardA1")?.props["rank"]).toBe("Q");
    // Bob learns nothing about alice's region: no values, no undo links, no group ids.
    expect(bobEvents.join("")).not.toContain("cardA1");
    expect(bobEvents.join("")).not.toContain("undoOf");
    expect(edit.join("")).toContain("cardA1");

    // Another participant cannot target alice's group; the refusal is generic.
    const forged = game.submit(
      envelope("replica-bob", 9, game.authority.getRevision(), [], {
        undoOf: undoRequest?.meta.undoOf ?? "",
      }),
      { actor: "bob" },
    );
    expect(forged.decision).toMatchObject({
      receipt: { outcome: "rejected", reason: "not authorized" },
    });
    expect(JSON.stringify(forged.eventsFor("bob"))).not.toContain("spades");

    // Revoked rights at redo time: the transfer of her hand is checked at commit; nothing half-applies.
    // (A second tab of alice's, with its own replica stream, hands the region to carol.)
    game.submit(
      envelope(
        "replica-alice-tab2",
        1,
        game.authority.getRevision(),
        build(game.fullView(), "replica-alice-tab2", 1, (b) => b.set("handA", "owner", "carol")),
      ),
      { actor: "alice" },
    );
    alice.client.redo();
    const redo = alice.client.nextRequest();
    const refused = game.submit(redo, { actor: "alice" });
    expect(refused.decision).toMatchObject({
      receipt: { outcome: "rejected", reason: "not authorized" },
    });
    expect(game.fullView().get("cardA1")?.props["rank"]).toBe("Q");
    // Participant exports carry no other region and no history payloads.
    const exported = JSON.stringify(game.exportFor("observer"));
    for (const secret of ["hearts", "spades", "cardB1", "cardA1"])
      expect(exported).not.toContain(secret);
  });
});
