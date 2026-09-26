import type { DocumentSnapshot, DocumentStore, ModelCommit } from "../core/store.ts";
import type { TableNode } from "../core/table.ts";
import type { DerivedGraph } from "./derived.ts";

/**
 * A runtime object mirroring one document node. `install` must be a
 * silent record copy (no layout, no observers); derived work belongs to the
 * derived graph and runs only at flush or on demand.
 */
export interface ProjectedInstance {
  install(row: TableNode): void;
  resolve?(lookup: (id: string) => ProjectedInstance | undefined): void;
  dispose?(): void;
}

export interface ProjectionOptions<I extends ProjectedInstance> {
  accepts(row: TableNode): boolean;
  create(row: TableNode): I;
  readonly graph?: DerivedGraph;
  readonly onError?: (error: unknown) => void;
}

/**
 * Headless two-phase class projection (v3 §4.3). For each final commit it
 * creates/installs/removes instances by node id with runtime reactions
 * suspended, resolves references, marks derived inputs dirty, and lets the
 * graph schedule one flush. Unaffected instances keep their identity. The
 * projection never writes the document.
 */
export class ClassProjection<I extends ProjectedInstance> {
  private readonly instances = new Map<string, I>();
  private snapshot: DocumentSnapshot;
  private updating = false;
  private readonly unsubscribe: () => void;

  constructor(
    store: DocumentStore,
    private readonly options: ProjectionOptions<I>,
  ) {
    this.snapshot = store.getSnapshot();
    this.rebuild(this.snapshot);
    this.unsubscribe = store.subscribeCommits((commit) => this.onCommit(commit));
  }

  get(id: string): I | undefined {
    return this.instances.get(id);
  }

  ids(): string[] {
    return [...this.instances.keys()];
  }

  /** True only inside the install phase; runtime reactions must not fire then. */
  isUpdating(): boolean {
    return this.updating;
  }

  installedRevision(): number {
    return this.snapshot.contentRevision;
  }

  dispose(): void {
    this.unsubscribe();
    for (const instance of this.instances.values()) instance.dispose?.();
    this.instances.clear();
  }

  private upsert(row: TableNode | undefined, id: string): void {
    const existing = this.instances.get(id);
    if (row === undefined || !this.options.accepts(row)) {
      existing?.dispose?.();
      this.instances.delete(id);
      return;
    }
    if (existing === undefined) {
      const created = this.options.create(row);
      created.install(row);
      this.instances.set(id, created);
    } else existing.install(row);
  }

  private resolveAll(): void {
    const lookup = (id: string): ProjectedInstance | undefined => this.instances.get(id);
    for (const instance of this.instances.values()) instance.resolve?.(lookup);
  }

  /** Full resynchronization from one complete snapshot (also the failure-recovery path). */
  rebuild(snapshot: DocumentSnapshot): void {
    this.updating = true;
    try {
      for (const id of [...this.instances.keys()])
        if (!snapshot.table.has(id)) this.upsert(undefined, id);
      for (const [id, row] of snapshot.table) this.upsert(row, id);
      this.resolveAll();
      this.snapshot = snapshot;
    } finally {
      this.updating = false;
    }
  }

  private onCommit(commit: ModelCommit): void {
    const summary = commit.changes;
    const affected = new Set([
      ...summary.created,
      ...summary.deleted,
      ...summary.children,
      ...summary.text,
      ...summary.props.map((p) => p.node),
      ...summary.moved.map((m) => m.node),
    ]);
    this.updating = true;
    try {
      for (const id of affected) {
        const row = commit.next.table.get(id);
        if (row !== commit.previous.table.get(id) || row === undefined) this.upsert(row, id);
      }
      this.resolveAll();
      this.snapshot = commit.next;
    } catch (error) {
      this.options.onError?.(error);
      this.updating = false;
      this.rebuild(commit.next);
    } finally {
      this.updating = false;
    }
    this.options.graph?.update(commit.next.table, summary);
  }
}
