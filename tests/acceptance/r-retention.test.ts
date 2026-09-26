import { describe, expect, test } from "bun:test";
import { exportCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { Client } from "../../src/core/client.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { proposeEdit, rebaseProposal } from "../../src/core/proposal.ts";
import { createAllocator, fromTable, ROOT_ID, textOf, toTable } from "../../src/core/table.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { listDoc, textDoc } from "../support/docs.ts";
import { Room } from "../support/room.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };

describe("R31 retention horizons and explicit recovery", () => {
  test("R31 Distinct retention needs and explicit recovery", () => {
    const room = new Room(textDoc("ab"));
    const own = room.join("own", "replica-o", "alice", { undoLimit: 2 });
    const other = room.join("other", "replica-r");
    const lagging = room.join("lagging", "replica-l");
    own.transact((w) => w.textInsert("t", 1, "X"));
    const firstRequest = own.nextRequest();
    room.submit("own", firstRequest);
    room.deliver("own");
    room.deliver("other");
    for (const ch of ["1", "2"]) {
      other.transact((w) => w.textInsert("t", 0, ch));
      room.send("other");
      room.deliver("other");
      room.deliver("own");
    }
    // Late-transform horizon: connected clients are caught up, so the prefix is retired...
    room.authority.pruneTransitionsThrough(room.authority.getRevision());
    // ...which does not break advertised undo: the handle already lives in the current context.
    expect(own.undo().status).toBe("requested");
    room.send("own");
    room.deliver("own");
    expect(textOf(room.authority.getTable().get("t"))).toBe("21ab");

    // A reconnect from a context older than the horizon is an explicit resync that keeps local intent.
    lagging.transact((w) => w.textInsert("t", 2, "L"));
    const decision = room.send("lagging");
    expect(decision?.kind).toBe("resync");
    lagging.resync(
      room.authority.getTable(),
      room.authority.getRevision(),
      "base past retained horizon",
    );
    expect(lagging.getStatus().retained).toEqual([
      expect.objectContaining({
        status: "resync",
        working: [expect.objectContaining({ text: "L" })],
      }),
    ]);
    expect(textOf(lagging.getSnapshot().table.get("t"))).toBe("21ab");
    // Proposals from an unavailable base are kept for review, never re-diffed against the current state.
    const proposal = proposeEdit(
      { table: textDoc("ab"), revision: 0 },
      { tag: "p", props: {}, content: ["abc"] },
      { replica: "replica-l", seq: 9 },
    );
    expect(rebaseProposal(proposal, room.authority).status).toBe("contextUnavailable");
    expect(proposal.changes).toHaveLength(1);

    // Deduplication horizon is separate: the receipt outlives the pruned transform prefix...
    const retry = room.submit("own", firstRequest);
    expect(retry).toMatchObject({
      kind: "decided",
      duplicate: true,
      receipt: { outcome: "applied" },
    });
    // ...and expiring receipts does not disturb retained transitions (archival replay stays possible).
    const archive = new Room(listDoc({ x: 0 }));
    const writer = archive.join("w", "replica-w");
    for (let i = 1; i <= 3; i += 1) {
      writer.transact((w) => w.set(ROOT_ID, "x", i));
      archive.send("w");
      archive.deliver("w");
    }
    archive.authority.expireReceiptsThrough(archive.authority.getRevision());
    expect(archive.authority.transitionsSince(0)).toHaveLength(3);
    const replayable = restoreAuthority(exportCheckpoint(archive.authority, SCHEMA, 2), [], SCHEMA);
    expect(replayable.transitionsSince(1)).toHaveLength(2);
    expect(replayable.transitionsSince(0)).toBeUndefined();

    // An expired old undo group reports unavailable without touching state.
    for (let i = 0; i < 3; i += 1) {
      own.closeGroup();
      own.transact((w) => w.textInsert("t", 0, `${i}`));
    }
    const before = own.getSnapshot();
    expect(own.undo("replica-o#1").status).toBe("unavailable");
    expect(own.getSnapshot()).toBe(before);

    // A standalone snapshot opens with no history and invents no authorship or undo groups.
    const parsed = parseDocument(`<doc><p id="p1">Standalone</p></doc>`, richTextSchema);
    if (!parsed.ok) throw new Error("fixture");
    const local = new Client({
      documentId: "local-file",
      historyEpoch: "none",
      allocator: SequenceAllocator.ephemeral("local"),
      actor: "me",
      table: toTable(parsed.value, createAllocator()),
      revision: 0,
    });
    expect(local.history.list()).toEqual([]);
    expect(local.undo().status).toBe("unavailable");
    expect(fromTable(local.getSnapshot().table, richTextSchema.id, richTextSchema.version)).toEqual(
      parsed.value,
    );
  });
});
