import type { JsonValue } from "../core/types.ts";
import type { PropPath } from "../core/json-path.ts";
import { getAtPath } from "../core/json-path.ts";
import type { ChangeSummary } from "../core/summary.ts";
import type { Table, TableNode } from "../core/table.ts";
import { textOf } from "../core/table.ts";

/** Injected frame/idle scheduler; the core never touches browser globals. */
export interface Scheduler {
  schedule(task: () => void): () => void;
}

/** Tracked reads available to a derivation; every read records a dependency edge. */
export interface DerivationContext {
  prop(node: string, path: PropPath): JsonValue | undefined;
  text(run: string): string;
  children(node: string): readonly string[];
  exists(node: string): boolean;
  derived<T>(key: string): T;
  external(name: string): number;
}

export type AsyncState<T> =
  | { readonly status: "ready"; readonly value: T; readonly version: number }
  | { readonly status: "notReady"; readonly version: number };

export class DependencyCycleError extends Error {}

interface Entry {
  readonly compute: (context: DerivationContext) => unknown;
  value?: unknown;
  dirty: boolean;
  deps: Set<string>;
}

/**
 * Lazy, dependency-indexed derived state over published snapshots (v3
 * §4.4). Commits only mark inputs dirty; computation happens on demand or
 * at an application-scheduled flush, at most once per dirty derivation, in
 * dependency order, against one snapshot. Cycles are diagnosed, not iterated.
 */
export class DerivedGraph {
  private readonly entries = new Map<string, Entry>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly externals = new Map<string, number>();
  private readonly computing: string[] = [];
  private cancelFlush: (() => void) | undefined;
  private table: Table;
  private version = 0;

  constructor(
    table: Table,
    private readonly scheduler?: Scheduler,
  ) {
    this.table = table;
  }

  get inputVersion(): number {
    return this.version;
  }

  define<T>(key: string, compute: (context: DerivationContext) => T): void {
    this.entries.set(key, { compute, dirty: true, deps: new Set() });
  }

  /**
   * An asynchronous-only derivation (e.g. a worker layout). Reading it
   * starts a job tagged with the input version; until that job completes
   * the read is explicitly `notReady`. A completion for superseded inputs
   * or a removed derivation is discarded, never installed as current.
   */
  defineAsync<T>(
    key: string,
    start: (context: DerivationContext, done: (value: T) => void) => void,
  ): void {
    let job = 0;
    this.define<AsyncState<T>>(key, (context) => {
      job += 1;
      const mine = job;
      const version = this.version;
      let immediate: AsyncState<T> | undefined;
      let returned = false;
      start(context, (value) => {
        const ready: AsyncState<T> = { status: "ready", value, version };
        if (!returned) {
          immediate = ready;
          return;
        }
        const entry = this.entries.get(key);
        if (entry !== undefined && mine === job && !entry.dirty) entry.value = ready;
      });
      returned = true;
      return immediate ?? { status: "notReady", version };
    });
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    for (const dep of entry.deps) this.dependents.get(dep)?.delete(key);
    this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Accept a new published snapshot and its verified changes; mark only affected inputs dirty. */
  update(table: Table, summary: ChangeSummary): void {
    this.table = table;
    this.version += 1;
    const keys: string[] = [];
    for (const id of [...summary.created, ...summary.deleted]) keys.push(`node:${id}`);
    for (const { node, path } of summary.props) keys.push(`prop:${node}:${String(path[0])}`);
    for (const id of summary.text) keys.push(`text:${id}`);
    for (const id of summary.children) keys.push(`children:${id}`);
    for (const { node } of summary.moved) keys.push(`node:${node}`);
    this.invalidate(keys);
    this.requestFlush();
  }

  /** External runtime input (e.g. font metrics) changed without any document mutation. */
  invalidateExternal(name: string): void {
    this.externals.set(name, (this.externals.get(name) ?? 0) + 1);
    this.version += 1;
    this.invalidate([`external:${name}`]);
    this.requestFlush();
  }

  private invalidate(inputs: readonly string[]): void {
    const queue = inputs.flatMap((input) => [...(this.dependents.get(input) ?? [])]);
    const nodeWide = inputs
      .filter((input) => input.startsWith("node:"))
      .map((input) => input.slice(5));
    for (const [dep, keys] of this.dependents)
      if (
        !dep.startsWith("derived:") &&
        !dep.startsWith("external:") &&
        nodeWide.some((id) => dep.includes(`:${id}:`) || dep.endsWith(`:${id}`))
      )
        queue.push(...keys);
    while (queue.length > 0) {
      const key = queue.pop() as string;
      const entry = this.entries.get(key);
      if (entry === undefined || entry.dirty) continue;
      entry.dirty = true;
      queue.push(...(this.dependents.get(`derived:${key}`) ?? []));
    }
  }

  private requestFlush(): void {
    if (this.scheduler === undefined || this.cancelFlush !== undefined) return;
    this.cancelFlush = this.scheduler.schedule(() => {
      this.cancelFlush = undefined;
      this.flush();
    });
  }

  /** Recompute every dirty derivation once, dependencies first. */
  flush(): void {
    for (const key of this.entries.keys())
      if (this.entries.get(key)?.dirty === true) this.read(key);
  }

  /** Synchronous demand: the latest value for the latest snapshot, computing its dependency closure. */
  read<T>(key: string): T {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`unknown derivation ${key}`);
    if (!entry.dirty) return entry.value as T;
    if (this.computing.includes(key))
      throw new DependencyCycleError(`dependency cycle: ${[...this.computing, key].join(" -> ")}`);
    this.computing.push(key);
    try {
      for (const dep of entry.deps) this.dependents.get(dep)?.delete(key);
      const deps = new Set<string>();
      const value = entry.compute(this.context(deps));
      entry.deps = deps;
      for (const dep of deps)
        this.dependents.set(dep, (this.dependents.get(dep) ?? new Set()).add(key));
      entry.value = value;
      entry.dirty = false;
      return value as T;
    } finally {
      this.computing.pop();
    }
  }

  private context(deps: Set<string>): DerivationContext {
    const row = (id: string): TableNode | undefined => this.table.get(id);
    return {
      prop: (node, path) => (
        deps.add(`prop:${node}:${String(path[0])}`),
        getAtPath(row(node)?.props ?? {}, path)
      ),
      text: (run) => (deps.add(`text:${run}`), textOf(row(run))),
      children: (node) => (deps.add(`children:${node}`), row(node)?.children ?? []),
      exists: (node) => (deps.add(`exists:${node}`), row(node) !== undefined),
      derived: <T>(key: string) => (deps.add(`derived:${key}`), this.read<T>(key)),
      external: (name) => (deps.add(`external:${name}`), this.externals.get(name) ?? 0),
    };
  }
}
