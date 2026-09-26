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
  | { readonly status: "notReady"; readonly version: number }
  | { readonly status: "failed"; readonly error: unknown; readonly version: number };

export class DependencyCycleError extends Error {}

interface Entry {
  readonly compute: (context: DerivationContext) => unknown;
  value?: unknown;
  dirty: boolean;
  /** Input key → the node it concerns (for node-wide invalidation), if any. */
  deps: Map<string, string | undefined>;
}

/** Unambiguous input keys (node ids and fields may contain any character). */
const inputKey = (...parts: string[]): string => JSON.stringify(parts);

/**
 * Lazy, dependency-indexed derived state over published snapshots (v3
 * §4.4). Commits only mark affected inputs dirty (found through reverse
 * indexes, never a scan of every entry); computation happens on demand or
 * at an application-scheduled flush, at most once per dirty derivation, in
 * dependency order, against one snapshot. Asynchronous results that land
 * later invalidate their dependents, schedule a flush, and notify
 * listeners; results for superseded inputs, removed or redefined keys are
 * discarded. Cycles are diagnosed, not iterated.
 */
export class DerivedGraph {
  private readonly entries = new Map<string, Entry>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly byNode = new Map<string, Set<string>>();
  private readonly externals = new Map<string, number>();
  private readonly listeners = new Set<(keys: readonly string[]) => void>();
  private readonly computing: string[] = [];
  private cancelFlush: (() => void) | undefined;
  private table: Table;
  private version = 0;

  constructor(
    table: Table,
    private readonly scheduler?: Scheduler,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.table = table;
  }

  get inputVersion(): number {
    return this.version;
  }

  /** (Re)define a derivation; a redefinition discards the old one's value and pending jobs. */
  define<T>(key: string, compute: (context: DerivationContext) => T): void {
    this.remove(key);
    this.entries.set(key, { compute, dirty: true, deps: new Map() });
    this.invalidate([inputKey("derived", key)]);
  }

  /**
   * An asynchronous derivation (e.g. a worker layout). Reading it starts a
   * job for the current inputs; until the job completes the read is
   * `notReady`. `done`/`fail` may be called synchronously or later. A later
   * completion is installed only if the key still names the same
   * definition, no newer job started, and its inputs are unchanged; it then
   * invalidates dependents like any input change.
   */
  defineAsync<T>(
    key: string,
    start: (
      context: DerivationContext,
      done: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): void {
    let job = 0;
    this.define<AsyncState<T>>(key, (context) => {
      const mine = ++job;
      const entry = this.entries.get(key);
      const version = this.version;
      let immediate: AsyncState<T> | undefined;
      let returned = false;
      const settle = (state: AsyncState<T>): void => {
        if (!returned) immediate = state;
        else if (entry !== undefined && mine === job) this.complete(key, entry, state);
      };
      start(
        context,
        (value) => settle({ status: "ready", value, version }),
        (error) => settle({ status: "failed", error, version }),
      );
      returned = true;
      return immediate ?? { status: "notReady", version };
    });
  }

  private complete(key: string, entry: Entry, state: unknown): void {
    if (this.entries.get(key) !== entry || entry.dirty) return;
    entry.value = state;
    this.invalidate([inputKey("derived", key)]);
    this.requestFlush();
    this.notify([key]);
  }

  /** Start a new job for a failed (or any) derivation on the next read or flush. */
  retry(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.dirty = true;
    this.invalidate([inputKey("derived", key)]);
    this.requestFlush();
  }

  /** Notified with derivation keys whose values changed outside a read (async results, flushes). */
  subscribe(listener: (keys: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const errors: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try {
        listener(keys);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const error of errors) {
      if (this.onError === undefined) throw error;
      this.onError(error);
    }
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.untrack(key, entry);
    this.entries.delete(key);
    this.invalidate([inputKey("derived", key)]);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Accept a new published snapshot and its verified changes; mark only affected inputs dirty. */
  update(table: Table, summary: ChangeSummary): void {
    this.table = table;
    this.version += 1;
    const keys: string[] = [];
    const nodes = [
      ...summary.created,
      ...summary.deleted,
      ...summary.moved.map((m) => m.node),
      ...summary.retagged.map((r) => r.node),
    ];
    for (const id of nodes) keys.push(...(this.byNode.get(id) ?? []));
    for (const { node, path } of summary.props) keys.push(inputKey("prop", node, String(path[0])));
    for (const id of summary.text) keys.push(inputKey("text", id));
    for (const id of summary.children) keys.push(inputKey("children", id));
    this.invalidate(keys);
    this.requestFlush();
  }

  /** External runtime input (e.g. font metrics) changed without any document mutation. */
  invalidateExternal(name: string): void {
    this.externals.set(name, (this.externals.get(name) ?? 0) + 1);
    this.version += 1;
    this.invalidate([inputKey("external", name)]);
    this.requestFlush();
  }

  private invalidate(inputs: readonly string[]): void {
    const queue = inputs.flatMap((input) => [...(this.dependents.get(input) ?? [])]);
    while (queue.length > 0) {
      const key = queue.pop() as string;
      const entry = this.entries.get(key);
      if (entry === undefined || entry.dirty) continue;
      entry.dirty = true;
      queue.push(...(this.dependents.get(inputKey("derived", key)) ?? []));
    }
  }

  private requestFlush(): void {
    if (this.scheduler === undefined || this.cancelFlush !== undefined) return;
    this.cancelFlush = this.scheduler.schedule(() => {
      this.cancelFlush = undefined;
      this.flush();
    });
  }

  /** Recompute every dirty derivation once, dependencies first; listeners hear which ones ran. */
  flush(): void {
    const recomputed: string[] = [];
    for (const key of [...this.entries.keys()])
      if (this.entries.get(key)?.dirty === true) {
        this.read(key);
        recomputed.push(key);
      }
    this.notify(recomputed);
  }

  private untrack(key: string, entry: Entry): void {
    for (const [dep, node] of entry.deps) {
      const keys = this.dependents.get(dep);
      keys?.delete(key);
      if (keys === undefined || keys.size > 0) continue;
      this.dependents.delete(dep);
      if (node !== undefined) this.byNode.get(node)?.delete(dep);
    }
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
      this.untrack(key, entry);
      const deps = new Map<string, string | undefined>();
      entry.deps = deps;
      const value = entry.compute(this.context(deps));
      for (const [dep, node] of deps) {
        this.dependents.set(dep, (this.dependents.get(dep) ?? new Set()).add(key));
        if (node !== undefined)
          this.byNode.set(node, (this.byNode.get(node) ?? new Set()).add(dep));
      }
      entry.value = value;
      entry.dirty = false;
      return value as T;
    } finally {
      this.computing.pop();
    }
  }

  private context(deps: Map<string, string | undefined>): DerivationContext {
    const row = (id: string): TableNode | undefined => this.table.get(id);
    const track = (key: string, node?: string): void => void deps.set(key, node);
    return {
      prop: (node, path) => (
        track(inputKey("prop", node, String(path[0])), node),
        getAtPath(row(node)?.props ?? {}, path)
      ),
      text: (run) => (track(inputKey("text", run), run), textOf(row(run))),
      children: (node) => (track(inputKey("children", node), node), row(node)?.children ?? []),
      exists: (node) => (track(inputKey("exists", node), node), row(node) !== undefined),
      derived: <T>(key: string) => (track(inputKey("derived", key)), this.read<T>(key)),
      external: (name) => (track(inputKey("external", name)), this.externals.get(name) ?? 0),
    };
  }
}
