import type { ProjectedInstance } from "../../src/runtime/projection.ts";
import type { DerivationContext, Scheduler } from "../../src/runtime/derived.ts";
import type { TableNode } from "../../src/core/table.ts";

/** Read a JSON value as text without default object stringification. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A fake frame scheduler: tasks run only when the test calls `frame()`. */
export class FakeScheduler implements Scheduler {
  private tasks: (() => void)[] = [];
  scheduled = 0;

  schedule(task: () => void): () => void {
    this.scheduled += 1;
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  }

  frame(): void {
    const tasks = this.tasks;
    this.tasks = [];
    for (const task of tasks) task();
  }

  pending(): number {
    return this.tasks.length;
  }
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function num(row: TableNode, key: string): number {
  const value = row.props[key];
  return typeof value === "number" ? value : 0;
}

/** Headless runtime shape: `install` copies fields silently and counts installs; no layout here. */
export class Shape implements ProjectedInstance {
  installs = 0;
  x = 0;
  y = 0;
  size = 0;
  constructor(readonly id: string) {}
  install(row: TableNode): void {
    this.installs += 1;
    this.x = num(row, "x");
    this.y = num(row, "y");
    this.size = num(row, "size");
  }
}

/** Connector K(from, to): resolves endpoint instances after every final record is installed. */
export class Connector implements ProjectedInstance {
  from = "";
  to = "";
  endpoints: [ProjectedInstance | undefined, ProjectedInstance | undefined] = [
    undefined,
    undefined,
  ];
  constructor(readonly id: string) {}
  install(row: TableNode): void {
    this.from = asText(row.props["from"]);
    this.to = asText(row.props["to"]);
  }
  resolve(lookup: (id: string) => ProjectedInstance | undefined): void {
    this.endpoints = [lookup(this.from), lookup(this.to)];
  }
}

export function createInstance(row: TableNode): Shape | Connector {
  return row.tag === "connector" ? new Connector(row.id) : new Shape(row.id);
}

export function acceptsShapes(row: TableNode): boolean {
  return ["circle", "triangle", "connector", "box"].includes(row.tag);
}

/** Counted derived computations (counters wrap the real work, not notifications). */
export class Counters {
  readonly counts = new Map<string, number>();
  hit(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

export function boundsOf(ctx: DerivationContext, id: string): Bounds {
  const x = Number(ctx.prop(id, ["x"]) ?? 0);
  const y = Number(ctx.prop(id, ["y"]) ?? 0);
  const size = Number(ctx.prop(id, ["size"]) ?? 0);
  return { x, y, w: size, h: size };
}
