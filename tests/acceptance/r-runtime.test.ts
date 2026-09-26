import { describe, expect, test } from "bun:test";
import type { ChangeSummary } from "../../src/core/summary.ts";
import type { Client } from "../../src/core/client.ts";
import { makeRow, ROOT_ID, TEXT_TAG } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { DependencyCycleError, DerivedGraph } from "../../src/runtime/derived.ts";
import type { AsyncState } from "../../src/runtime/derived.ts";
import { ClassProjection } from "../../src/runtime/projection.ts";
import { createSelector } from "../../src/runtime/selector.ts";
import type { Bounds, Connector } from "../support/canvas.ts";
import {
  acceptsShapes,
  asText,
  boundsOf,
  Counters,
  createInstance,
  FakeScheduler,
  Shape,
} from "../support/canvas.ts";
import { tableFrom } from "../support/gen.ts";
import { Room } from "../support/room.ts";

function canvas(): Table {
  return tableFrom([
    makeRow(ROOT_ID, "canvas", { zoom: 1 }, null, ["C", "T", "X", "K", "B", "K2"], false),
    makeRow("C", "circle", { x: 0, y: 0, size: 10 }, ROOT_ID, [], true),
    makeRow("T", "triangle", { x: 100, y: 0, size: 20 }, ROOT_ID, [], true),
    makeRow("X", "triangle", { x: 500, y: 500, size: 5 }, ROOT_ID, [], true),
    makeRow("K", "connector", { from: "C", to: "T" }, ROOT_ID, [], true),
    makeRow("B", "box", { x: 10, y: 10, width: 40, font: "serif" }, ROOT_ID, ["bt"], true),
    makeRow("bt", TEXT_TAG, { value: "hello world again" }, "B", [], false),
    makeRow("K2", "connector", { from: "B", to: "C" }, ROOT_ID, [], true),
  ]);
}

interface Fixture {
  room: Room;
  client: Client;
  graph: DerivedGraph;
  projection: ClassProjection<Shape | Connector>;
  counters: Counters;
  scheduler: FakeScheduler;
  metrics: { charWidth: number };
}

function setup(): Fixture {
  const room = new Room(canvas());
  const client = room.join("a", "replica-a");
  const scheduler = new FakeScheduler();
  const graph = new DerivedGraph(client.getSnapshot().table, scheduler);
  const counters = new Counters();
  const metrics = { charWidth: 5 };
  for (const id of ["C", "T", "X"])
    graph.define(`bounds:${id}`, (ctx) => {
      counters.hit(`bounds:${id}`);
      return boundsOf(ctx, id);
    });
  graph.define("layout:B", (ctx) => {
    counters.hit("layout:B");
    ctx.external("fontMetrics");
    const text = ctx
      .children("B")
      .map((run) => ctx.text(run))
      .join("");
    const width = Number(ctx.prop("B", ["width"]));
    const font = asText(ctx.prop("B", ["font"]));
    const perLine = Math.max(
      1,
      Math.floor(width / (font === "mono" ? metrics.charWidth * 2 : metrics.charWidth)),
    );
    return { lines: Math.ceil(text.length / perLine) };
  });
  graph.define("bounds:B", (ctx) => {
    counters.hit("bounds:B");
    const layout = ctx.derived<{ lines: number }>("layout:B");
    return {
      x: Number(ctx.prop("B", ["x"])),
      y: Number(ctx.prop("B", ["y"])),
      w: Number(ctx.prop("B", ["width"])),
      h: layout.lines * 10,
    };
  });
  for (const id of ["K", "K2"])
    graph.define(`geometry:${id}`, (ctx) => {
      counters.hit(`geometry:${id}`);
      const from = ctx.derived<Bounds>(`bounds:${asText(ctx.prop(id, ["from"]))}`);
      const to = ctx.derived<Bounds>(`bounds:${asText(ctx.prop(id, ["to"]))}`);
      return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    });
  graph.flush();
  const projection = new ClassProjection(client, {
    accepts: acceptsShapes,
    create: createInstance,
    graph,
  });
  return { room, client, graph, projection, counters, scheduler, metrics };
}

describe("R41–R44 runtime projections and derived state", () => {
  test("R41 Class projections update once and resolve dependencies coherently", () => {
    const f = setup();
    const circle = f.projection.get("C") as Shape;
    const connector = f.projection.get("K") as Connector;
    const untouched = f.projection.get("X");
    const baseline = f.counters.get("geometry:K");
    f.client.transact((b) => {
      for (let i = 1; i <= 25; i += 1) b.set("C", "x", i).set("T", "y", i * 2);
    });
    expect(circle.installs).toBe(2); // initial install + one final record, not 25 setter calls
    expect(f.counters.get("geometry:K")).toBe(baseline); // nothing computed before the flush
    f.scheduler.frame();
    expect(f.counters.get("geometry:K")).toBe(baseline + 1);
    expect(f.graph.read<Record<string, number>>("geometry:K")).toEqual({
      x1: 25,
      y1: 0,
      x2: 100,
      y2: 50,
    }); // final C with final T
    expect(connector.endpoints[0]).toBe(circle);
    expect(f.projection.get("X")).toBe(untouched);
    expect(f.room.authority.getRevision()).toBe(0); // derived geometry never becomes a document operation
    // Retarget K to X, then change and delete the old endpoint T: K is no longer invalidated by T.
    f.client.transact((b) => b.set("K", "to", "X"));
    f.scheduler.frame();
    expect(f.graph.read<Record<string, number>>("geometry:K")).toEqual({
      x1: 25,
      y1: 0,
      x2: 500,
      y2: 500,
    });
    const afterRetarget = f.counters.get("geometry:K");
    expect(connector.endpoints[1]).toBe(untouched);
    f.client.transact((b) => b.set("T", "x", 7));
    f.scheduler.frame();
    f.client.transact((b) => b.deleteNode("T"));
    f.scheduler.frame();
    expect(f.counters.get("geometry:K")).toBe(afterRetarget);
    expect(f.projection.get("T")).toBeUndefined();
    f.room.settle();
    expect(f.room.authority.getTable().get("K")?.props["to"]).toBe("X");
  });

  test("R42 Multiple commits coalesce into one scheduled derived flush", () => {
    const f = setup();
    const commits: number[] = [];
    f.client.subscribeCommits(() => commits.push(1));
    const before = {
      layout: f.counters.get("layout:B"),
      boundsB: f.counters.get("bounds:B"),
      k2: f.counters.get("geometry:K2"),
      x: f.counters.get("bounds:X"),
    };
    for (let i = 1; i <= 30; i += 1) f.client.transact((b) => b.set("B", "x", 10 + i));
    expect(commits).toHaveLength(30); // every transition is committed and observable
    expect(f.scheduler.pending()).toBe(1);
    f.scheduler.frame();
    expect(f.counters.get("bounds:B")).toBe(before.boundsB + 1);
    expect(f.counters.get("geometry:K2")).toBe(before.k2 + 1);
    expect(f.counters.get("layout:B")).toBe(before.layout); // position-only move keeps line layout
    expect(f.counters.get("bounds:X")).toBe(before.x);
    expect(f.graph.read<Bounds>("bounds:B").x).toBe(40);
    // A pure visual scale is not a text-reflow input; a width or font change is.
    f.client.transact((b) => b.set(ROOT_ID, "zoom", 2));
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(before.layout);
    f.client.transact((b) => b.set("B", "width", 20));
    f.client.transact((b) => b.set("B", "font", "mono"));
    f.scheduler.frame();
    expect(f.counters.get("layout:B")).toBe(before.layout + 1);
    expect(f.graph.read<{ lines: number }>("layout:B").lines).toBe(9);
    f.room.settle();
    expect(f.room.authority.getRevision()).toBe(33);
  });

  test("R43 Demand, async completion, and external runtime inputs", () => {
    const f = setup();
    f.client.transact((b) => b.set("C", "x", 77));
    // Synchronous hit-testing before the scheduled flush reads the latest valid geometry.
    expect(f.graph.read<Record<string, number>>("geometry:K")).toMatchObject({ x1: 77 });
    const count = f.counters.get("geometry:K");
    f.scheduler.frame();
    expect(f.counters.get("geometry:K")).toBe(count); // the flush does not repeat demanded work

    const jobs: { run: string; done: (value: number) => void }[] = [];
    f.graph.defineAsync<number>("asyncLayout:B", (ctx, done) => {
      const run = ctx
        .children("B")
        .map((r) => ctx.text(r))
        .join("");
      jobs.push({ run, done });
    });
    const first = f.graph.read<AsyncState<number>>("asyncLayout:B");
    expect(first.status).toBe("notReady");
    f.client.transact((b) => b.textInsert("bt", 0, "new "));
    const second = f.graph.read<AsyncState<number>>("asyncLayout:B");
    expect(second).toEqual({ status: "notReady", version: f.graph.inputVersion });
    jobs[0]?.done(1); // stale completion for the old revision is discarded
    expect(f.graph.read<AsyncState<number>>("asyncLayout:B").status).toBe("notReady");
    jobs[1]?.done(2);
    expect(f.graph.read<AsyncState<number>>("asyncLayout:B")).toMatchObject({
      status: "ready",
      value: 2,
    });
    f.client.transact((b) => b.deleteNode("B"));
    f.graph.remove("asyncLayout:B");
    jobs[1]?.done(3);
    expect(f.projection.get("B")).toBeUndefined();

    // External font metrics invalidate layout without any document mutation.
    const g = setup();
    const layouts = g.counters.get("layout:B");
    g.metrics.charWidth = 10;
    g.graph.invalidateExternal("fontMetrics");
    g.scheduler.frame();
    expect(g.counters.get("layout:B")).toBe(layouts + 1);
    expect(g.room.authority.getRevision()).toBe(0);
    // Cycles are diagnosed instead of spinning or exposing half-results.
    g.graph.define("cycle:a", (ctx) => ctx.derived("cycle:b"));
    g.graph.define("cycle:b", (ctx) => ctx.derived("cycle:a"));
    expect(() => g.graph.read("cycle:a")).toThrow(DependencyCycleError);
  });

  test("R44 Stable snapshot/selector and failure contracts", () => {
    const f = setup();
    let computed = 0;
    const count = createSelector(
      f.client,
      (snapshot) => [snapshot.table.get("C"), snapshot.table.get("T")] as const,
      (c, t) => {
        computed += 1;
        return Number(c?.props["x"]) + Number(t?.props["x"]);
      },
    );
    expect(count.get()).toBe(100);
    const snapshot = f.client.getSnapshot();
    expect(f.client.getSnapshot()).toBe(snapshot);
    const rowC = snapshot.table.get("C");
    expect(() => {
      (rowC as { props: unknown }).props = {};
    }).toThrow();
    f.client.transact((b) => b.set("X", "x", 1)); // unrelated input
    expect(count.get()).toBe(100);
    expect(computed).toBe(1);
    f.room.settle(); // same-content own acknowledgement
    expect(count.get()).toBe(100);
    expect(computed).toBe(1);
    expect(snapshot.table.get("C")).toBe(rowC); // an old snapshot is never mutated

    // Summaries: nested anonymous values, reparenting, creation/deletion, and a net-zero change.
    const summaries: ChangeSummary[] = [];
    const off = f.client.subscribeCommits((commit) => summaries.push(commit.changes));
    f.client.transact((b) => b.set(ROOT_ID, "meta", { tags: [{ name: "a" }] }));
    f.client.transact((b) => b.set(ROOT_ID, ["meta", "tags", 0, "name"], "b"));
    f.client.transact((b) => b.moveNode("bt", "C", 0));
    f.client.transact((b) => {
      b.insertNode(ROOT_ID, 0, { tag: "circle", id: "N", props: { x: 1 } });
      b.deleteNode("X");
    });
    f.client.transact((b) => b.set("C", "x", 5).set("C", "x", 0));
    off();
    expect(summaries[1]?.props).toEqual([{ node: ROOT_ID, path: ["meta", "tags", 0, "name"] }]);
    expect(summaries[2]?.moved).toEqual([{ node: "bt", from: "B", to: "C" }]);
    expect(summaries[3]?.created).toEqual(["N"]);
    expect(summaries[3]?.deleted).toEqual(["X"]);
    expect(summaries).toHaveLength(4); // the net-zero transaction publishes no model change

    // A failing projection reports the error, recovers from the full snapshot, and keeps processing.
    const errors: unknown[] = [];
    let explode = true;
    const fragile = new ClassProjection(f.client, {
      accepts: acceptsShapes,
      create: (row) => {
        if (row.id === "Z" && explode) {
          explode = false;
          throw new Error("projection failure");
        }
        return createInstance(row);
      },
      onError: (error) => errors.push(error),
    });
    f.client.transact(
      (b) => void b.insertNode(ROOT_ID, 0, { tag: "circle", id: "Z", props: { x: 3 } }),
    );
    expect(errors).toHaveLength(1);
    expect(fragile.get("Z")).toBeInstanceOf(Shape);
    f.client.transact((b) => b.set("Z", "x", 4));
    expect((fragile.get("Z") as Shape).x).toBe(4);
    f.room.settle();
    expect(f.room.authority.getTable().get("Z")?.props["x"]).toBe(4);
  });
});
