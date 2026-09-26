import { describe, expect, test } from "bun:test";
import type { ChangeBuilder } from "../../src/core/builder.ts";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import type { DecisionRecord } from "../../src/core/authority.ts";
import type { Change } from "../../src/core/change.ts";
import { invertChange, invertChanges } from "../../src/core/change.ts";
import { Client } from "../../src/core/client.ts";
import { diffToChanges } from "../../src/core/diff.ts";
import { AuthorityHost } from "../../src/core/host.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import type { StoredHistory } from "../../src/core/host.ts";
import { fromTable, makeRow, ROOT_ID, textOf } from "../../src/core/table.ts";
import type { Table, TableNode } from "../../src/core/table.ts";
import { DerivedGraph } from "../../src/runtime/derived.ts";
import { ClassProjection } from "../../src/runtime/projection.ts";
import { asText, FakeScheduler } from "../support/canvas.ts";
import { FakeStore } from "../support/fake-store.ts";
import { setupGame } from "../support/game.ts";
import { tableFrom } from "../support/gen.ts";
import { listDoc, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };

describe("R33 negative controls: history, publication, and runtime faults are detected", () => {
  test("R33 Negative controls detect wrong-but-green history implementations", async () => {
    // Raw current→old-snapshot undo deletes remote text; the real collaborative undo keeps it.
    const undoResult = (snapshotUndo: boolean): string => {
      const room = new Room(textDoc("ab"));
      const own = room.join("own", "replica-o");
      const remote = room.join("remote", "replica-r");
      const before = room.authority.getTable();
      own.transact((b) => b.textInsert("t", 1, "X"));
      room.settle();
      remote.transact((b) => b.textInsert("t", 3, "Y"));
      room.settle();
      if (snapshotUndo)
        own.transact((b) =>
          diffToChanges(b.current(), fromTable(before, "x", "1").root, {
            replica: "replica-o",
            seq: 99,
          }).forEach((c) => b.record(c)),
        );
      else own.undo();
      room.settle();
      return textOf(room.authority.getTable().get("t"));
    };
    expect(undoResult(false)).toBe("abY");
    expect(undoResult(true)).not.toBe("abY");

    // Reject-all-post-remote-undo: refusing every undo once remote work arrived loses compatible undo.
    const rejectAfterRemote = (client: Client, hadRemote: boolean) =>
      hadRemote ? { status: "conflict" } : client.undo();
    const room = new Room(textDoc("ab"));
    const own = room.join("own", "replica-o");
    own.transact((b) => b.textInsert("t", 1, "X"));
    room.settle();
    room.join("r", "replica-r").transact((b) => b.textInsert("t", 0, ">"));
    room.settle();
    expect(rejectAfterRemote(own, true).status).not.toBe("requested");
    expect(own.undo().status).toBe("requested");

    // Hidden replay-to-materialize: an inverter that cannot invert without old state drops records.
    const base = textDoc("abcd");
    const record = JSON.parse(
      JSON.stringify(
        build(base, "replica-a", 1, (b) => b.textDelete("t", 1, 2).textInsert("t", 0, ">")),
      ),
    ) as Change[];
    const post = applyChanges(base, record);
    const needsState = (records: readonly Change[]) =>
      records
        .filter((c) => c.kind !== "textDelete")
        .map(invertChange)
        .reverse();
    expect(textOf(applyChanges(post, invertChanges(record)).get("t"))).toBe("abcd");
    expect(textOf(applyChanges(post, needsState(record)).get("t"))).not.toBe("abcd");

    // Checkpoint "handles" that only reference a deleted prefix cannot undo after truncation.
    const restartAndUndo = (referenceOnly: boolean): string => {
      const r = new Room(listDoc({ x: 0 }));
      const c = r.join("c", "replica-c");
      c.transact((b) => b.set(ROOT_ID, "x", 1));
      r.settle();
      r.authority.pruneTransitionsThrough(r.authority.getRevision());
      const session = c.exportSession();
      const damaged = referenceOnly
        ? {
            ...session,
            history: {
              ...session.history,
              groups: session.history.groups.map((g) => ({
                ...g,
                undo: { changes: [], dropped: 0 },
              })),
            },
          }
        : session;
      const revived = new Client({
        documentId: DOC,
        historyEpoch: EPOCH,
        allocator: SequenceAllocator.ephemeral("replica-c2"),
        actor: "c",
        table: r.authority.getTable(),
        revision: r.authority.getRevision(),
        restore: damaged,
      });
      return revived.undo().status;
    };
    expect(restartAndUndo(false)).toBe("requested");
    expect(restartAndUndo(true)).not.toBe("requested");

    // A stale concurrent writer that appends without compare-and-commit forks the history.
    class CarelessStore extends FakeStore {
      override async append(
        _expected: number,
        owner: number,
        record: DecisionRecord,
      ): Promise<"committed" | "stale" | "fenced"> {
        return super.append((await this.read()).position, owner, record);
      }
    }
    const forks = async (store: FakeStore): Promise<number[]> => {
      const genesis = () => Authority.create(DOC, EPOCH, textDoc("ab"));
      const one = await AuthorityHost.open(store, SCHEMA, genesis);
      const owner = store.currentOwner();
      const stale = one.authority.prepare(
        envelope(
          "replica-s",
          1,
          0,
          build(textDoc("ab"), "replica-s", 1, (b) => b.textInsert("t", 0, "S")),
        ),
        { actor: "s" },
      );
      await one.submit(
        envelope(
          "replica-o",
          1,
          0,
          build(textDoc("ab"), "replica-o", 1, (b) => b.textInsert("t", 0, "O")),
        ),
        { actor: "o" },
      );
      const staleRecord =
        stale.decision.kind === "decided"
          ? {
              actor: "s",
              fingerprint: "stale",
              receipt: stale.decision.receipt,
              ...(stale.decision.transition === undefined
                ? {}
                : { transition: stale.decision.transition }),
            }
          : undefined;
      if (staleRecord !== undefined) await store.append(0, owner, staleRecord);
      const history: StoredHistory = await store.read();
      return history.records.flatMap((r) =>
        r.transition === undefined ? [] : [r.transition.revision],
      );
    };
    expect(await forks(new FakeStore())).toEqual([1]);
    expect(await forks(new CarelessStore())).toEqual([1, 1]);
  });

  test("R33 Negative controls detect wrong-but-green publication and runtime", () => {
    // Intermediate expensive notifications: one publication per primitive instead of per batch.
    const notifications = (perPrimitive: boolean): number => {
      const room = new Room(listDoc({ x: 0, items: [] }));
      const client = room.join("c", "replica-c");
      let expensive = 0;
      client.subscribeCommits(() => (expensive += 1));
      const steps = (b: ChangeBuilder, i: number) => void b.arrayInsert(ROOT_ID, ["items"], i, [i]);
      if (perPrimitive) for (let i = 0; i < 10; i += 1) client.transact((b) => steps(b, i));
      else
        client.transact((b) => {
          for (let i = 0; i < 10; i += 1) steps(b, i);
        });
      return expensive;
    };
    expect(notifications(false)).toBe(1);
    expect(notifications(true)).toBe(10);

    // Inverse/old-value disclosure: forwarding the raw transition to another region leaks secrets.
    const game = setupGame();
    const decision = game.submit(
      envelope(
        "replica-bob",
        1,
        0,
        build(game.fullView(), "replica-bob", 1, (b) => b.deleteNode("cardB1")),
      ),
      { actor: "bob" },
    );
    const raw =
      decision.decision.kind === "decided" ? JSON.stringify(decision.decision.transition) : "";
    expect(JSON.stringify(decision.eventsFor("alice"))).not.toContain("hearts");
    expect(raw).toContain("hearts");

    // Setters that lay out eagerly: a naive adapter replaying every primitive into class setters runs
    // layout per primitive; the two-phase projection installs one final record per commit.
    const layouts = (naive: boolean): number => {
      const room = new Room(
        tableFrom([
          makeRow(ROOT_ID, "canvas", {}, null, ["B"], false),
          makeRow("B", "box", { x: 0, width: 10 }, ROOT_ID, [], true),
        ]),
      );
      const client = room.join("c", "replica-c");
      let computed = 0;
      const box = { install: (_row: TableNode) => void (computed += 1) };
      if (naive)
        client.subscribeCommits((commit) =>
          commit.mapping.forEach(() => box.install(makeRow("B", "box", {}, ROOT_ID, [], true))),
        );
      else new ClassProjection(client, { accepts: (row) => row.tag === "box", create: () => box });
      const baseline = computed;
      client.transact((b) => {
        for (let i = 1; i <= 25; i += 1) b.set("B", "x", i);
      });
      return computed - baseline;
    };
    expect(layouts(false)).toBe(1);
    expect(layouts(true)).toBe(25);

    // Dropped dependency edges: a derivation that reads without tracking misses its new endpoint's change.
    const staleGeometry = (tracked: boolean): number => {
      const scheduler = new FakeScheduler();
      let current: Table = tableFrom([
        makeRow(ROOT_ID, "c", { target: "A" }, null, [], false),
        makeRow("A", "n", { x: 1 }, ROOT_ID, [], true),
        makeRow("B", "n", { x: 2 }, ROOT_ID, [], true),
      ]);
      const graph = new DerivedGraph(current, scheduler);
      graph.define("geo", (ctx) => {
        const target = asText(ctx.prop(ROOT_ID, ["target"]));
        return tracked ? Number(ctx.prop(target, ["x"])) : Number(current.get(target)?.props["x"]);
      });
      graph.read("geo");
      const step = (changes: Change[]) => {
        const next = applyChanges(current, changes);
        graph.update(next, {
          candidates: [],
          created: [],
          deleted: [],
          props: changes.map((c) => ({
            node: (c as { node: string }).node,
            path: (c as unknown as { path: string[] }).path,
          })),
          text: [],
          children: [],
          moved: [],
          retagged: [],
        });
        current = next;
        scheduler.frame();
      };
      step(build(current, "replica-a", 1, (b) => b.set(ROOT_ID, "target", "B")));
      step(build(current, "replica-a", 2, (b) => b.set("B", "x", 9)));
      return graph.read<number>("geo");
    };
    expect(staleGeometry(true)).toBe(9);
    expect(staleGeometry(false)).not.toBe(9);

    // Stale async layout installation: completing an old job must not overwrite newer input.
    const asyncResult = (checkVersion: boolean): unknown => {
      let current = textDoc("one");
      const graph = new DerivedGraph(current);
      const jobs: ((v: string) => void)[] = [];
      let installed: string | undefined;
      graph.defineAsync<string>("layout", (ctx, done) => {
        const text = ctx.text("t");
        jobs.push((v) => {
          if (!checkVersion) installed = v;
          done(v);
        });
        void text;
      });
      graph.read("layout");
      const edit = build(current, "replica-a", 1, (b) => b.textInsert("t", 0, "x"));
      current = applyChanges(current, edit);
      graph.update(current, {
        candidates: ["t"],
        created: [],
        deleted: [],
        props: [],
        text: ["t"],
        children: [],
        moved: [],
        retagged: [],
      });
      graph.read("layout");
      jobs[0]?.("stale-for-one");
      const state = graph.read<{ status: string; value?: string }>("layout");
      return checkVersion ? state.value : installed;
    };
    expect(asyncResult(true)).toBeUndefined();
    expect(asyncResult(false)).toBe("stale-for-one");
  });
});
