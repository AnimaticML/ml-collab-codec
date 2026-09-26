import type { RequestId } from "./identity.ts";
import { requestKey } from "./identity.ts";
import type { ReceiptEvent } from "./protocol.ts";

/** A retained terminal receipt plus the canonical bytes of the request it answered. */
export interface ReceiptRecord {
  readonly fingerprint: string;
  readonly receipt: ReceiptEvent;
}

/** Per-replica accounting: authenticated owner, highest sequence seen, and the expiry boundary. */
export interface ReplicaRecord {
  readonly actor: string;
  readonly highestSeq: number;
  /** Sequences ≤ this may have had their receipts pruned; unknown ones are never treated as new. */
  readonly expiredThrough: number;
}

type LookupResult =
  | { readonly kind: "found"; readonly record: ReceiptRecord }
  | { readonly kind: "new" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface LedgerExport {
  readonly receipts: readonly ReceiptRecord[];
  readonly replicas: readonly (ReplicaRecord & { readonly replica: string })[];
  readonly groups: readonly { readonly group: string; readonly actor: string }[];
}

/**
 * Exact retry accounting (v3 §5.7): an explicit receipt table, not a
 * highest-counter shortcut. The highest sequence only refuses stale unknown
 * ids; it never manufactures an outcome.
 */
export class Ledger {
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly replicas = new Map<string, ReplicaRecord>();
  private readonly groups = new Map<string, string>();

  static fromExport(data: LedgerExport): Ledger {
    const ledger = new Ledger();
    for (const record of data.receipts)
      ledger.receipts.set(requestKey(record.receipt.request), record);
    for (const { replica, ...record } of data.replicas) ledger.replicas.set(replica, record);
    for (const { group, actor } of data.groups) ledger.groups.set(group, actor);
    return ledger;
  }

  export(): LedgerExport {
    return {
      receipts: [...this.receipts.values()],
      replicas: [...this.replicas].map(([replica, record]) => ({ replica, ...record })),
      groups: [...this.groups].map(([group, actor]) => ({ group, actor })),
    };
  }

  /** The authenticated actor a replica is bound to, if any. */
  ownerOf(replica: string): string | undefined {
    return this.replicas.get(replica)?.actor;
  }

  groupOwner(group: string): string | undefined {
    return this.groups.get(group);
  }

  lookup(id: RequestId): LookupResult {
    const record = this.receipts.get(requestKey(id));
    if (record !== undefined) return { kind: "found", record };
    const replica = this.replicas.get(id.replica);
    if (replica !== undefined && id.seq <= replica.expiredThrough)
      return {
        kind: "unavailable",
        reason: "the request's receipt is past the retained deduplication horizon",
      };
    if (replica !== undefined && id.seq <= replica.highestSeq)
      return {
        kind: "unavailable",
        reason: "an unknown request below the replica's accepted sequence cannot be new",
      };
    return { kind: "new" };
  }

  record(
    actor: string,
    fingerprint: string,
    receipt: ReceiptEvent,
    group: string | undefined,
  ): void {
    const { replica, seq } = receipt.request;
    const previous = this.replicas.get(replica);
    this.replicas.set(replica, {
      actor,
      highestSeq: Math.max(previous?.highestSeq ?? 0, seq),
      expiredThrough: previous?.expiredThrough ?? 0,
    });
    this.receipts.set(requestKey(receipt.request), { fingerprint, receipt });
    if (group !== undefined && receipt.outcome === "applied" && !this.groups.has(group))
      this.groups.set(group, actor);
  }

  /** Explicit expiry: drop receipts evaluated at or before `revision`, remembering the boundary per replica. */
  expireThrough(revision: number): number {
    let removed = 0;
    for (const [key, { receipt }] of this.receipts) {
      if (receipt.evaluatedRevision > revision) continue;
      const replica = this.replicas.get(receipt.request.replica);
      if (replica !== undefined)
        this.replicas.set(receipt.request.replica, {
          ...replica,
          expiredThrough: Math.max(replica.expiredThrough, receipt.request.seq),
        });
      this.receipts.delete(key);
      removed += 1;
    }
    return removed;
  }
}
