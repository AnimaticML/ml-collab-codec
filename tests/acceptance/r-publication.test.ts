import { describe, expect, test } from "bun:test";
import { schemaInvariants } from "../../src/core/invariants.ts";
import type { ModelCommit, StatusEvent } from "../../src/core/store.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { ApplyError } from "../../src/core/staging.ts";
import { mapAnchor } from "../../src/core/anchors.ts";
import { items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { Room } from "../support/room.ts";

function recorder(client: {
  subscribeCommits(l: (c: ModelCommit) => void): () => void;
  subscribeStatus(l: (s: StatusEvent) => void): () => void;
}) {
  const commits: ModelCommit[] = [];
  const statuses: StatusEvent[] = [];
  client.subscribeCommits((commit) => commits.push(commit));
  client.subscribeStatus((status) => statuses.push(status));
  return { commits, statuses };
}

describe("R23–R26 publication batches and derived state", () => {
  test("R23 Large application batch has one observation boundary", () => {
    const room = new Room(listDoc({ items: ["a"], x: 0 }), {
      validators: [schemaInvariants(listSchema)],
    });
    const client = room.join("a", "replica-a");
    const seen: Table[] = [];
    let expensive = 0;
    client.subscribeCommits((commit) => {
      expensive += 1; // the counted expensive derivation runs inside the listener
      seen.push(commit.next.table);
    });
    const { commits } = recorder(client);
    client.transact((b) => {
      b.arrayDelete(ROOT_ID, ["items"], 0); // invalid domain intermediate: empty required collection
      for (let i = 0; i < 50; i += 1) b.arrayInsert(ROOT_ID, ["items"], i, [`v${i}`]);
      for (let i = 0; i < 20; i += 1) b.set(ROOT_ID, "x", i + 1);
      for (let i = 0; i < 10; i += 1)
        void b.insertNode(ROOT_ID, i, { tag: "item", id: `n${i}`, props: { label: `${i}` } });
      for (let i = 0; i < 10; i += 2) b.moveNode(`n${i}`, ROOT_ID, 10);
    });
    expect(expensive).toBe(1);
    expect(commits).toHaveLength(1);
    const final = seen[0] as Table;
    expect((items(final) as unknown[]).length).toBe(50);
    expect(final.get(ROOT_ID)?.props["x"]).toBe(20);
    expect(commits[0]?.changes.created).toHaveLength(10);
    expect(commits[0]?.changes.props.map((p) => p.path[0]).sort()).toEqual(["items", "x"]);
    expect(client.history.list()).toHaveLength(1);
    room.settle();
    expect(room.decisions).toHaveLength(1);
    expect(items(room.authority.getTable())).toEqual(items(final));
  });

  test("R24 Reconciliation is published as one consistent update", () => {
    const room = new Room(textDoc("0123456789"));
    const local = room.join("local", "replica-l");
    const remote = room.join("remote", "replica-r");
    for (let i = 0; i < 5; i += 1) {
      local.transact((b) => b.textInsert("t", 2 * i + i, `${String.fromCharCode(65 + i)}`));
      local.closeGroup();
    }
    remote.transact((b) => b.textInsert("t", 0, "<"));
    remote.closeGroup();
    remote.transact((b) => b.textInsert("t", 11, ">"));
    remote.closeGroup();
    remote.transact((b) => b.textDelete("t", 5, 2));
    for (let i = 0; i < 3; i += 1) {
      room.send("remote"); // one in flight per replica: acknowledge before sending the next
      room.deliver("remote");
    }
    const { commits } = recorder(local);
    let computations = 0;
    local.subscribeCommits(() => (computations += 1));
    room.deliver("local"); // one receive carrying three remote transitions
    expect(commits).toHaveLength(1);
    expect(computations).toBe(1);
    expect(local.getStatus().integrations).toEqual({ forward: 3, recovery: 0 });
    // Mapping is the incoming work mapped past the pending chain, not a rebuild from the confirmed base.
    expect(commits[0]?.mapping.length).toBeLessThanOrEqual(4);
    const anchor = mapAnchor(
      { kind: "point", node: "t", offset: 0, affinity: "before" },
      commits[0]?.mapping ?? [],
    );
    expect(anchor.status).toBe("mapped");
    expect(local.state.pending).toHaveLength(5);
    room.settle();
    expect(textOf(local.getSnapshot().table.get("t"))).toBe(
      textOf(room.authority.getTable().get("t")),
    );
    // Hand-derived: A and "<" tie at gap 0 (replica-l < replica-r); C and D straddle the deleted "45".
    expect(textOf(room.authority.getTable().get("t"))).toBe("A<01B23CD67E89>");

    // Rejection of the in-flight request uses the private recovery path, still one publication.
    const rej = new Room(listDoc({ x: 0, title: "t" }));
    const first = rej.join("first", "replica-f");
    const second = rej.join("second", "replica-s");
    first.transact((b) => b.set(ROOT_ID, "x", 1));
    second.transact((b) => b.set(ROOT_ID, "x", 2));
    second.closeGroup();
    second.transact((b) => b.set(ROOT_ID, "title", "kept"));
    rej.send("first");
    rej.send("second");
    const log = recorder(second);
    rej.deliver("second");
    expect(log.commits).toHaveLength(1);
    expect(second.getSnapshot().table.get(ROOT_ID)?.props).toEqual({ x: 1, title: "kept" });
    expect(second.getStatus().integrations.recovery).toBeGreaterThan(0);
  });

  test("R25 Acknowledgements, no-ops, and rejections", () => {
    const room = new Room(textDoc("ab"));
    const a = room.join("a", "replica-a");
    const b = room.join("b", "replica-b");
    a.transact((x) => x.textInsert("t", 1, "X"));
    room.send("a");
    const snapshot = a.getSnapshot();
    const log = recorder(a);
    const events = [...room.member("a").inbox];
    room.deliver("a");
    expect(log.commits).toHaveLength(0); // same-content acknowledgement: no model invalidation
    expect(log.statuses.at(-1)?.confirmedRevision).toBe(1);
    expect(a.getSnapshot()).toBe(snapshot);
    a.receive(events); // repeated receipt/transition
    expect(log.commits).toHaveLength(0);
    expect(a.getSnapshot()).toBe(snapshot);

    // A rejected server transaction produces no model event anywhere; the optimistic author reconciles once.
    const other = recorder(b);
    room.deliver("b");
    const before = other.commits.length;
    a.transact((x) => x.textDelete("t", 0, 1));
    b.transact((x) => x.textDelete("t", 0, 1));
    room.send("a");
    room.send("b"); // alreadySatisfied, not an error
    b.transact((x) => x.textInsert("t", 0, "!"));
    room.settle();
    expect(other.commits.length - before).toBeLessThanOrEqual(3);
    expect(textOf(b.getSnapshot().table.get("t"))).toBe(textOf(room.authority.getTable().get("t")));

    const conflict = new Room(listDoc({ x: 0 }));
    const p = conflict.join("p", "replica-p");
    const q = conflict.join("q", "replica-q");
    const watcher = conflict.join("w", "replica-w");
    p.transact((x) => x.set(ROOT_ID, "x", 1));
    q.transact((x) => x.set(ROOT_ID, "x", 2));
    conflict.send("p");
    conflict.deliver("w");
    const w = recorder(watcher);
    conflict.send("q");
    conflict.deliver("w");
    expect(w.commits).toHaveLength(0);
    const qLog = recorder(q);
    conflict.deliver("q");
    expect(qLog.commits).toHaveLength(1);
    expect(qLog.commits[0]?.cause).not.toBe("local");
    expect(q.getSnapshot().table.get(ROOT_ID)?.props["x"]).toBe(1);
  });

  test("R26 Failures and reentrant observers preserve the boundary", () => {
    const room = new Room(listDoc({ x: 0, title: "t" }));
    const client = room.join("a", "replica-a");
    const { commits } = recorder(client);
    const snapshot = client.getSnapshot();
    expect(() =>
      client.transact((b) => {
        b.set(ROOT_ID, "x", 1);
        throw new Error("pre-commit failure");
      }),
    ).toThrow("pre-commit failure");
    expect(() => client.transact((b) => b.arrayDelete(ROOT_ID, ["missing"], 0))).toThrow(
      ApplyError,
    );
    expect(client.getSnapshot()).toBe(snapshot);
    expect(commits).toHaveLength(0);
    expect(client.state.pending).toHaveLength(0);
    client.transact((b) => b.set(ROOT_ID, "x", 2));
    expect(commits).toHaveLength(1);

    // Reentrant edit from an observer becomes a later, separate commit.
    const errors: unknown[] = [];
    client.subscribeErrors((error) => errors.push(error));
    const order: string[] = [];
    let reacted = false;
    const off = client.subscribeCommits((commit) => {
      order.push(`saw x=${JSON.stringify(commit.next.table.get(ROOT_ID)?.props["x"])}`);
      if (!reacted && commit.next.table.get(ROOT_ID)?.props["x"] === 3) {
        reacted = true;
        const queued = client.transact((b) => b.set(ROOT_ID, "title", "follow-up"));
        order.push(queued.status);
      }
    });
    client.subscribeCommits(() => {
      throw new Error("subscriber failure");
    });
    client.transact((b) => b.set(ROOT_ID, "x", 3));
    off();
    expect(order).toEqual(["saw x=3", "queued", "saw x=3"]);
    expect(commits.slice(-2).map((c) => c.next.table.get(ROOT_ID)?.props["title"])).toEqual([
      "t",
      "follow-up",
    ]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // The failing subscriber did not uncommit anything; later delivery still works.
    client.transact((b) => b.set(ROOT_ID, "x", 4));
    expect(client.getSnapshot().table.get(ROOT_ID)?.props).toEqual({ x: 4, title: "follow-up" });
    room.settle();
    expect(room.authority.getTable().get(ROOT_ID)?.props).toEqual({ x: 4, title: "follow-up" });
    expect(
      room.decisions.every((d) => d.kind === "decided" && d.receipt.outcome === "applied"),
    ).toBe(true);
  });
});
