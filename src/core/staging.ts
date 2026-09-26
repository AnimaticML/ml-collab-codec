import type { Table, TableNode } from "./table.ts";

export type ApplyErrorCode =
  | "missingNode"
  | "preconditionFailed"
  | "outOfRange"
  | "idCollision"
  | "cycle"
  | "numericProfile"
  | "invalidTarget";

/** A failed primitive precondition. The staged candidate is discarded; nothing is published. */
export class ApplyError extends Error {
  constructor(
    readonly code: ApplyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Private copy-on-write staging over an immutable table (v3 §4.2). Rows
 * that are not written keep their object identity in the frozen result, so
 * consumers can compare row references instead of deep-comparing documents.
 */
export class StagedTable {
  private readonly writes = new Map<string, TableNode | null>();

  constructor(private readonly base: Table) {}

  get(id: string): TableNode | undefined {
    const written = this.writes.get(id);
    if (written === null) return undefined;
    return written ?? this.base.get(id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  require(id: string): TableNode {
    const row = this.get(id);
    if (row === undefined) throw new ApplyError("missingNode", `node ${id} does not exist`);
    return row;
  }

  set(row: TableNode): void {
    this.writes.set(row.id, Object.freeze(row));
  }

  delete(id: string): void {
    this.writes.set(id, null);
  }

  /** Ids written (created, changed, or deleted) since staging began. */
  touched(): ReadonlySet<string> {
    return new Set(this.writes.keys());
  }

  freeze(): Table {
    if (this.writes.size === 0) return this.base;
    const next = new Map(this.base);
    for (const [id, row] of this.writes) {
      if (row === null) next.delete(id);
      else next.set(id, row);
    }
    return next;
  }
}
