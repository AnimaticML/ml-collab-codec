import { describe, expect, test } from "bun:test";
import type { ModelCommit } from "../../src/core/store.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "../../src/core/table.ts";
import { DerivedGraph } from "../../src/runtime/derived.ts";
import type { AsyncState } from "../../src/runtime/derived.ts";
import { ClassProjection } from "../../src/runtime/projection.ts";
import type { Bounds, Connector, Shape } from "../support/canvas.ts";
import {
  acceptsShapes,
  boundsOf,
  Counters,
  createInstance,
  FakeScheduler,
} from "../support/canvas.ts";
import { tableFrom } from "../support/gen.ts";
import { Room } from "../support/room.ts";

function canvas() {
  return tableFrom([
    makeRow(ROOT_ID, "canvas", {}, null, ["C", "T", "X", "K", "B", "K2"], false),
    makeRow("C", "circle", { x: 0, y: 0, size: 10 }, ROOT_ID, [], true),
    makeRow("T", "triangle", { x: 100, y: 0, size: 20 }, ROOT_ID, [], true),
    makeRow("X", "triangle", { x: 500, y: 500, size: 5 }, ROOT_ID, [], true),
    makeRow("K", "connector", { from: "C", to: "T" }, ROOT_ID, [], true),
    makeRow("B", "box", { x: 10, y: 10, font: "serif" }, ROOT_ID, ["bt"], true),
    makeRow("bt", TEXT_TAG, { value: "hello world" }, "B", [], false),
    makeRow("K2", "connector", { from: "B", to: "C" }, ROOT_ID, [], true),
  ]);
}

interface Job {
  readonly text: string;
  readonly done: (width: number) => void;
  readonly fail: (error: unknown) => void;
}

/**
 * A canvas whose text layout is asynchronous (a worker measures the box's
 * text): width ← layout (async), box bounds ← width, connector K2 geometry
 * ← box and circle bounds. Counters wrap the real computations.
 */
function setup() {
  const room = new Room(canvas());
  const client = room.join("a", "replica-a");
  const scheduler = new FakeScheduler();
  const errors: unknown[] = [];
  const graph = new DerivedGraph(client.getSnapshot().table, scheduler, (e) => errors.push(e));
  const counters = new Counters();
  const jobs: Job[] = [];
  graph.defineAsync<number>("layout:B", (ctx, done, fail) => {
    counters.hit("layout:B");
    ctx.external("fontMetrics");
    const text = ctx
      .children("B")
      .map((run) => ctx.text(run))
      .join("");
    jobs.push({ text, done, fail });
  });
  graph.define<AsyncState<number>>("width:B", (ctx) => {
    counters.hit("width:B");
    const layout = ctx.derived<AsyncState<number>>("layout:B");
    return layout.status === "ready" ? { ...layout, value: layout.value + 4 } : layout;
  });
  const bounds = (id: string) =>
    graph.define(`bounds:${id}`, (ctx) => {
      counters.hit(`bounds:${id}`);
      if (id !== "B") return boundsOf(ctx, id);
      const width = ctx.derived<AsyncState<number>>("width:B");
      return width.status === "ready"
        ? {
            x: Number(ctx.prop("B", ["x"])),
            y: Number(ctx.prop("B", ["y"])),
            w: width.value,
            h: 10,
          }
        : undefined;
    });
  for (const id of ["C", "T", "X", "B"]) bounds(id);
  const connector = (id: string, from: string, to: string) =>
    graph.define(`geometry:${id}`, (ctx) => {
      counters.hit(`geometry:${id}`);
      const a = ctx.derived<Bounds | undefined>(`bounds:${from}`);
      const b = ctx.derived<Bounds | undefined>(`bounds:${to}`);
      return a === undefined || b === undefined ? "pending" : [a.x + a.w, b.x];
    });
  connector("K", "C", "T");
  connector("K2", "B", "C");
  const projection = new ClassProjection<Shape | Connector>(client, {
    accepts: acceptsShapes,
    create: createInstance,
    graph,
  });
  const notified: string[][] = [];
  graph.subscribe((keys) => notified.push([...keys]));
  return { room, client, scheduler, graph, counters, jobs, projection, notified, errors };
}

describe("MR22–MR24 asynchronous derived state and scheduled work", () => {
  test("MR22 Async completion reaches dependents without a document edit", () => {
    const f = setup();
    f.graph.flush();
    f.notified.length = 0;
    expect(f.graph.read<unknown>("geometry:K2")).toBe("pending");
    expect(f.jobs).toHaveLength(1);
    const before = { width: f.counters.get("width:B"), k2: f.counters.get("geometry:K2") };
    // The worker completes later: exactly the dependent closure is invalidated and recomputed at the
    // scheduled flush (unrelated connector K is not), and listeners hear both steps.
    f.jobs[0]?.done(60);
    expect(f.notified).toEqual([["layout:B"]]);
    expect(f.scheduler.pending()).toBe(1);
    f.scheduler.frame();
    expect([...(f.notified[1] ?? [])].sort()).toEqual(["bounds:B", "geometry:K2", "width:B"]);
    expect(f.counters.get("width:B")).toBe(before.width + 1);
    expect(f.counters.get("geometry:K2")).toBe(before.k2 + 1);
    expect(f.graph.read<unknown>("geometry:K2")).toEqual([74, 0]);
    // Synchronous completion inside `start` is ready at first read.
    f.graph.defineAsync<number>("sync", (_ctx, done) => done(7));
    expect(f.graph.read("sync")).toMatchObject({ status: "ready", value: 7 });
  });

  test("MR23 Replaced, removed, redefined, failed, and stale async jobs never publish", () => {
    const f = setup();
    f.graph.read<unknown>("geometry:K2");
    // Input change: the old job's late result is discarded; dependents read notReady, not stale data.
    f.client.transact((b) => b.textInsert("bt", 0, "big "));
    f.jobs[0]?.done(1);
    expect(f.notified).toEqual([]);
    expect(f.graph.read("width:B")).toMatchObject({ status: "notReady" });
    // A newer completed job wins over an older job completing afterwards.
    f.client.transact((b) => b.textInsert("bt", 0, "a "));
    f.graph.read("width:B");
    const [older, newer] = [f.jobs[1], f.jobs[2]];
    newer?.done(20);
    older?.done(99);
    expect(f.graph.read("width:B")).toMatchObject({ status: "ready", value: 24 });
    // Unrelated input changes follow the freshness rule: layout stays ready, not recomputed.
    const layouts = f.counters.get("layout:B");
    f.client.transact((b) => b.set("X", "x", 1));
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(layouts);
    // External font metrics invalidate layout without a document edit.
    f.graph.invalidateExternal("fontMetrics");
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(layouts + 1);
    // Failure, then an explicit retry.
    f.jobs.at(-1)?.fail(new Error("worker crashed"));
    f.scheduler.frame();
    expect(f.graph.read("width:B")).toMatchObject({ status: "failed" });
    f.graph.retry("layout:B");
    f.scheduler.frame();
    f.jobs.at(-1)?.done(30);
    f.scheduler.frame();
    expect(f.graph.read("width:B")).toMatchObject({ status: "ready", value: 34 });
    // Same-key redefinition and removal discard the old definition's pending jobs.
    f.client.transact((b) => b.textInsert("bt", 0, "c "));
    f.graph.read("width:B");
    const orphan = f.jobs.at(-1);
    f.graph.defineAsync<number>("layout:B", (_ctx, done) => done(5));
    orphan?.done(500);
    expect(f.graph.read("width:B")).toMatchObject({ status: "ready", value: 9 });
    f.graph.defineAsync<number>("late", (_ctx, done) =>
      f.jobs.push({ text: "", done, fail: () => undefined }),
    );
    f.graph.read("late");
    f.graph.remove("late");
    f.jobs.at(-1)?.done(1);
    expect(f.graph.has("late")).toBe(false);
    // Dependency changes: a derivation that stops reading an input no longer depends on it.
    let useX = true;
    f.graph.define("switch", (ctx) => (useX ? ctx.prop("X", ["x"]) : ctx.prop("T", ["x"])));
    f.graph.read("switch");
    useX = false;
    f.graph.retry("switch");
    f.graph.read("switch");
    f.client.transact((b) => b.set("X", "x", 2));
    f.scheduler.frame();
    expect(f.notified.at(-1)).not.toContain("switch");
  });

  test("MR24 Coherent publication and scheduled work", () => {
    const f = setup();
    f.graph.read<unknown>("geometry:K");
    f.jobs[0]?.done(40);
    f.scheduler.frame();
    const geometry = () => f.counters.get("geometry:K");
    const start = geometry();
    // Circle and triangle move in one transaction: the connector sees final positions, once.
    const commits: ModelCommit[] = [];
    f.client.subscribeCommits((c) => commits.push(c));
    f.client.transact((b) => b.set("C", "x", 5).set("T", "x", 200));
    f.scheduler.frame();
    expect([commits.length, geometry(), f.graph.read<unknown>("geometry:K")]).toEqual([
      1,
      start + 1,
      [15, 200],
    ]);
    // Many commits before a frame coalesce into one flush.
    const scheduled = f.scheduler.scheduled;
    for (const x of [6, 7, 8]) f.client.transact((b) => b.set("C", "x", x));
    expect(f.scheduler.scheduled).toBe(scheduled + 1);
    f.scheduler.frame();
    expect(geometry()).toBe(start + 2);
    // Text changes invalidate layout; a pure position change of the box does not.
    const layouts = f.counters.get("layout:B");
    f.client.transact((b) => b.set("B", "x", 99));
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(layouts);
    f.client.transact((b) => b.textInsert("bt", 0, "x"));
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(layouts + 1);
    // An explicit current-value read computes the needed closure before any frame.
    f.client.transact((b) => b.set("T", "x", 300));
    expect(f.graph.read<unknown>("geometry:K")).toEqual([18, 300]);
    // Subscriber failure goes to the error channel; other listeners still run.
    const heard: number[] = [];
    f.graph.subscribe(() => {
      throw new Error("listener bug");
    });
    f.graph.subscribe((keys) => heard.push(keys.length));
    f.client.transact((b) => b.set("C", "x", 1));
    f.scheduler.frame();
    expect([f.errors.length, heard.length]).toEqual([1, 1]);
    // Reentrancy: a commit subscriber's edit runs after delivery, as its own later commit.
    const seen: number[] = [];
    const stop = f.client.subscribeCommits((c) => {
      seen.push(c.next.contentRevision);
      if (seen.length === 1) f.client.transact((b) => b.set("X", "y", 1));
    });
    f.client.transact((b) => b.set("X", "y", 2));
    stop();
    const first = seen[0] ?? -1;
    expect(seen).toEqual([first, first + 1]);
    expect(f.projection.installedRevision()).toBe(f.client.getSnapshot().contentRevision);
    // Unchanged acknowledgements publish nothing and invalidate nothing.
    f.room.settle();
    f.scheduler.frame();
    const quiet = { commits: commits.length, geometry: geometry() };
    f.client.transact((b) => b.set("C", "x", 2));
    f.scheduler.frame();
    f.room.settle();
    f.scheduler.frame();
    expect([commits.length, geometry()]).toEqual([quiet.commits + 1, quiet.geometry + 1]);
    // A rejected request is reconciled in one commit; no intermediate state reaches the graph.
    f.client.transact((b) => b.set("C", "x", 50));
    const rejected = f.client.nextRequest();
    const refusal = f.room.authority.refuse(rejected, { actor: "a" }, "not allowed");
    if (refusal.kind !== "decided") throw new Error("setup");
    const before = commits.length;
    f.client.receive(refusal.receipt);
    f.scheduler.frame();
    expect(commits.length).toBe(before + 1);
    expect(f.graph.read<unknown>("geometry:K")).toEqual([12, 300]);
    expect(f.projection.installedRevision()).toBe(f.client.getSnapshot().contentRevision);
    expect(f.client.getStatus().retained).toEqual([
      expect.objectContaining({ status: "rejected" }),
    ]);
  });
});
