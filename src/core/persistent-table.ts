import type { TableNode } from "./table.ts";

type Bucket = ReadonlyMap<string, TableNode>;

/** Target average rows per bucket; the bucket count is fixed per lineage until the table grows 4x. */
const ROWS_PER_BUCKET = 16;
const MAX_BUCKET_BITS = 16;

/** FNV-1a over UTF-16 code units: stable, allocation-free bucket selection for ids. */
function hash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bitsFor(size: number): number {
  let bits = 0;
  while (bits < MAX_BUCKET_BITS && (1 << bits) * ROWS_PER_BUCKET < size) bits += 1;
  return bits;
}

/**
 * An immutable id → row index with structural sharing. Rows are spread over
 * hash buckets; deriving a new version copies the bucket array (pointers
 * only) and just the buckets that change, so one edit costs roughly
 * O(bucket count + changed rows) instead of copying every row reference.
 * Versions never observe each other's writes. Iteration order is by
 * bucket and carries no meaning; document order lives in `children`.
 */
export class PersistentTable implements ReadonlyMap<string, TableNode> {
  private constructor(
    private readonly buckets: readonly (Bucket | undefined)[],
    readonly size: number,
  ) {}

  /** Adopt any table; a plain Map is indexed once, a persistent table is reused as is. */
  static from(source: ReadonlyMap<string, TableNode>): PersistentTable {
    return source instanceof PersistentTable
      ? source
      : PersistentTable.build(source.values(), source.size);
  }

  private static build(rows: Iterable<TableNode>, size: number): PersistentTable {
    const count = 1 << bitsFor(size);
    const buckets: Map<string, TableNode>[] = [];
    for (const row of rows) {
      const index = hash(row.id) & (count - 1);
      const bucket = buckets[index] ?? new Map<string, TableNode>();
      buckets[index] = bucket;
      bucket.set(row.id, row);
    }
    buckets.length = count;
    let total = 0;
    for (const bucket of buckets) total += bucket?.size ?? 0;
    return new PersistentTable(buckets, total);
  }

  private bucketOf(id: string): number {
    return hash(id) & (this.buckets.length - 1);
  }

  get(id: string): TableNode | undefined {
    return this.buckets[this.bucketOf(id)]?.get(id);
  }

  has(id: string): boolean {
    return this.buckets[this.bucketOf(id)]?.has(id) ?? false;
  }

  /** A new version with `writes` applied (`null` deletes); this version is unchanged. */
  with(writes: ReadonlyMap<string, TableNode | null>): PersistentTable {
    if (writes.size === 0) return this;
    const buckets = [...this.buckets];
    const copied = new Set<number>();
    let size = this.size;
    for (const [id, row] of writes) {
      const index = this.bucketOf(id);
      if (!copied.has(index)) {
        buckets[index] = new Map(buckets[index]);
        copied.add(index);
      }
      const bucket = buckets[index] as Map<string, TableNode>;
      const had = bucket.has(id);
      if (row === null) {
        if (had) size -= 1;
        bucket.delete(id);
      } else {
        if (!had) size += 1;
        bucket.set(id, row);
      }
    }
    const next = new PersistentTable(buckets, size);
    const grown =
      size > buckets.length * ROWS_PER_BUCKET * 4 && buckets.length < 1 << MAX_BUCKET_BITS;
    return grown ? PersistentTable.build(next.values(), size) : next;
  }

  *entries(): MapIterator<[string, TableNode]> {
    for (const bucket of this.buckets) if (bucket !== undefined) yield* bucket.entries();
  }

  *keys(): MapIterator<string> {
    for (const bucket of this.buckets) if (bucket !== undefined) yield* bucket.keys();
  }

  *values(): MapIterator<TableNode> {
    for (const bucket of this.buckets) if (bucket !== undefined) yield* bucket.values();
  }

  [Symbol.iterator](): MapIterator<[string, TableNode]> {
    return this.entries();
  }

  forEach(
    callback: (value: TableNode, key: string, map: ReadonlyMap<string, TableNode>) => void,
  ): void {
    for (const [id, row] of this.entries()) callback(row, id, this);
  }
}
