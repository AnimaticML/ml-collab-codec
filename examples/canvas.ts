/**
 * Runnable runtime-integration example (v3 §4, R41–R44): headless circle,
 * triangle, and connector classes projected from the document store with a
 * two-phase install, a dependency-indexed derived graph flushed by an
 * injected frame scheduler, and a functional selector on the same store.
 * Run with: bun run examples/canvas.ts
 */
import {
  ClassProjection,
  createAllocator,
  createSelector,
  DerivedGraph,
  toTable,
} from "../src/index.ts";
import type { ProjectedInstance, TableNode } from "../src/index.ts";
import { LocalRoom } from "./lib/local-room.ts";

/** Read a JSON value as text without default object stringification. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

class Shape implements ProjectedInstance {
  x = 0;
  y = 0;
  install(row: TableNode): void {
    this.x = Number(row.props["x"]);
    this.y = Number(row.props["y"]);
  }
}

class Connector implements ProjectedInstance {
  ends: string[] = [];
  endpoints: (ProjectedInstance | undefined)[] = [];
  install(row: TableNode): void {
    this.ends = [text(row.props["from"]), text(row.props["to"])];
  }
  resolve(lookup: (id: string) => ProjectedInstance | undefined): void {
    this.endpoints = this.ends.map(lookup);
  }
}

const frames: (() => void)[] = [];
const scheduler = { schedule: (task: () => void) => (frames.push(task), () => undefined) };
const room = new LocalRoom(
  toTable(
    {
      schemaId: "example.canvas",
      schemaVersion: "1.0.0",
      root: {
        tag: "canvas",
        props: {},
        content: [
          { tag: "circle", id: "C", props: { x: 0, y: 0 } },
          { tag: "triangle", id: "T", props: { x: 100, y: 0 } },
          { tag: "connector", id: "K", props: { from: "C", to: "T" } },
        ],
      },
    },
    createAllocator(),
  ),
);
const client = room.join("designer");
const graph = new DerivedGraph(client.getSnapshot().table, scheduler);
let geometryRuns = 0;
graph.define("geometry:K", (ctx) => {
  geometryRuns += 1;
  const [from, to] = [text(ctx.prop("K", ["from"])), text(ctx.prop("K", ["to"]))];
  return { x1: ctx.prop(from, ["x"]), x2: ctx.prop(to, ["x"]) };
});
const projection = new ClassProjection<Shape | Connector>(client, {
  accepts: (row) => row.tag !== "canvas",
  create: (row) => (row.tag === "connector" ? new Connector() : new Shape()),
  graph,
});
const distance = createSelector(
  client,
  (s) => [s.table.get("C"), s.table.get("T")] as const,
  (c, t) => Number(t?.props["x"]) - Number(c?.props["x"]),
);

for (let step = 1; step <= 20; step += 1)
  client.transact((b) => b.set("C", "x", step).set("T", "x", 100 + step * 2));
console.log("commits published, derived runs before the frame:", geometryRuns);
frames.splice(0).forEach((frame) => frame());
console.log("connector geometry after one frame:", graph.read("geometry:K"), "runs:", geometryRuns);
console.log(
  "connector resolved endpoints:",
  (projection.get("K") as Connector).endpoints.every((end) => end instanceof Shape),
);
console.log("selector distance:", distance.get());
room.settle();
if (geometryRuns !== 1 || distance.get() !== 120 || room.authority.getRevision() !== 20)
  throw new Error("unexpected runtime state");
console.log("EXAMPLE_OK");
