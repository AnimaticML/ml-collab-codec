import { expect, test } from "bun:test";
import { hiddenHandSchema } from "../fixtures/hidden-hand-schema.ts";
import { parseDocument, parseFragment } from "../../src/core/parser.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import { fromTable } from "../../src/core/table.ts";
import { projectTable, PUBLIC_REGION } from "../../src/core/visibility.ts";
import { setupGame } from "../support/game.ts";
import { build, envelope } from "../support/requests.ts";

const ids = (table: ReadonlyMap<string, unknown>) => [...table.keys()];

test("V01 Participant snapshots and histories", () => {
  const game = setupGame();
  expect(ids(game.view("alice"))).toContain("cardA1");
  expect(ids(game.view("alice"))).not.toContain("cardB1");
  expect(ids(game.view("bob"))).toContain("cardB1");
  expect(ids(game.view("bob"))).not.toContain("cardA1");
  expect([...game.view("observer").values()].some((row) => row.tag === "card")).toBe(false);
  // Histories are projected per participant too: bob's private edit reaches no one else.
  const edit = game.submit(
    envelope(
      "replica-bob",
      1,
      0,
      build(game.fullView(), "replica-bob", 1, (b) => b.set("cardB1", "rank", "8")),
    ),
    { actor: "bob" },
  );
  expect(JSON.stringify(edit.eventsFor("alice"))).not.toContain("cardB1");
  expect(JSON.stringify(edit.eventsFor("observer"))).not.toContain("cardB1");
  expect(JSON.stringify(edit.eventsFor("bob"))).toContain('"8"');
});

test("V02 No secret old-value leakage", () => {
  // Two full states differing only in bob's secret, under the same observable schedule.
  const observed = ["7", "K"].map((rank) => {
    const game = setupGame(rank);
    const privateEdit = game.submit(
      envelope(
        "replica-bob",
        1,
        0,
        build(game.fullView(), "replica-bob", 1, (b) => b.set("cardB1", "suit", "clubs")),
      ),
      { actor: "bob" },
    );
    const play = game.submitAction(
      "alice",
      "playCard",
      { cardId: "cardA1" },
      { replica: "replica-alice", seq: 1 },
    );
    const failed = game.submit(
      envelope(
        "replica-alice",
        2,
        0,
        build(game.fullView(), "replica-alice", 2, (b) => b.set("cardB1", "rank", "A")),
      ),
      { actor: "alice" },
    );
    return JSON.stringify({
      events: [privateEdit, play, failed].map((d) => d.eventsFor("alice")),
      view: fromTable(game.view("alice"), "x", "1"),
      export: game.exportFor("alice"),
    });
  });
  expect(observed[0]).toBe(observed[1] as string);
  expect(observed[0]).not.toContain("hearts");
  expect(observed[0]).not.toContain("clubs");
});

test("V03 Authority checks access", () => {
  const game = setupGame();
  const denied = game.submitAction(
    "bob",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-bob", seq: 1 },
  );
  expect(denied.decision).toMatchObject({
    kind: "decided",
    receipt: { outcome: "rejected", reason: "not authorized" },
  });
  // A client-side claim of prior validation is not a field the protocol accepts at all.
  const scoped = game.submit(
    envelope(
      "replica-bob",
      2,
      0,
      build(game.fullView(), "replica-bob", 2, (b) => b.set("cardA1", "rank", "K")),
    ),
    { actor: "bob" },
  );
  expect(scoped.decision).toMatchObject({
    receipt: { outcome: "rejected", reason: "not authorized" },
  });
  expect(() =>
    game.submit({ ...envelope("replica-bob", 3, 0, []), validated: true }, { actor: "bob" }),
  ).toThrow();
  expect(game.fullView().get("cardA1")?.props["rank"]).toBe("Q");
});

test("V04 Partial replacement is not deletion", () => {
  const game = setupGame();
  // Alice may edit the public table but cannot address a list containing another region's hidden children.
  const forbidden = game.submit(
    envelope(
      "replica-alice",
      1,
      0,
      build(game.fullView(), "replica-alice", 1, (b) => b.deleteNode("handB")),
    ),
    { actor: "alice" },
  );
  expect(forbidden.decision).toMatchObject({ receipt: { outcome: "rejected" } });
  const viaRoot = game.submit(
    envelope(
      "replica-alice",
      2,
      0,
      build(
        game.fullView(),
        "replica-alice",
        2,
        (b) => void b.insertNode("$root", 0, { tag: "table", id: "t2" }),
      ),
    ),
    { actor: "alice" },
  );
  expect(viaRoot.decision).toMatchObject({ receipt: { outcome: "rejected" } });
  expect(ids(game.view("bob"))).toContain("cardB1");
});

test("V05 Rights changed before commit", () => {
  const game = setupGame();
  // The hand is given to bob between alice's read and her action: rights are evaluated at commit.
  game.submit(
    envelope(
      "replica-alice",
      1,
      0,
      build(game.fullView(), "replica-alice", 1, (b) => b.set("handA", "owner", "bob")),
    ),
    { actor: "alice" },
  );
  const receipt = game.submitAction(
    "alice",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-alice", seq: 2 },
  );
  expect(receipt.decision).toMatchObject({ receipt: { outcome: "rejected" } });
  expect(game.fullView().get("cardA1")?.parentId).toBe("handA");
});

test("V06 Authorized reveal is atomic", () => {
  const game = setupGame();
  const receipt = game.submitAction(
    "alice",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-alice", seq: 1 },
  );
  expect(receipt.decision).toMatchObject({ receipt: { outcome: "applied" } });
  const observer = game.view("observer");
  expect(ids(observer)).toContain("cardA1");
  expect(ids(observer)).not.toContain("cardB1");
  const events = receipt.eventsFor("observer");
  expect(JSON.stringify(events)).toContain("spades");
  expect(JSON.stringify(events)).not.toContain("hearts");
  expect(projectTable(game.view("observer"), hiddenHandSchema, PUBLIC_REGION).size).toBeGreaterThan(
    0,
  );
  // The same action id replays the recorded outcome instead of moving the card twice.
  const again = game.submitAction(
    "alice",
    "playCard",
    { cardId: "cardA1" },
    { replica: "replica-alice", seq: 1 },
  );
  expect(again.decision).toEqual(receipt.decision);
});

test("V07 Complete and partial export", () => {
  const game = setupGame();
  const fullSource = serializeDocument(
    fromTable(game.fullView(), hiddenHandSchema.id, hiddenHandSchema.version),
    hiddenHandSchema,
  );
  expect(fullSource.includes("cardA1") && fullSource.includes("cardB1")).toBe(true);
  expect(parseDocument(fullSource, hiddenHandSchema).ok).toBe(true);
  const partial = game.exportFor("alice");
  expect(partial.partial).toBe(true);
  const aliceSource = serializeDocument(
    fromTable(
      new Map(partial.rows.map((row) => [row.id, row])),
      hiddenHandSchema.id,
      hiddenHandSchema.version,
    ),
    hiddenHandSchema,
  );
  expect(parseFragment(aliceSource, hiddenHandSchema).diagnostics).toEqual([]);
  expect(aliceSource.includes("cardB1")).toBe(false);
  expect(aliceSource.includes("cardA1")).toBe(true);
});
