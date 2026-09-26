import type { CoalescingPolicy, HistoryPolicy } from "./grouping.ts";
import type { HistoryExport } from "./history.ts";
import type { PendingEntry, RetainedIntent } from "./client-queue.ts";
import type { RequestId, SequenceAllocator } from "./identity.ts";
import type { Table } from "./table.ts";

export interface ClientOptions {
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly allocator: SequenceAllocator;
  /** Authenticated actor/session association supplied by the host, used for local grouping only. */
  readonly actor: string;
  readonly session?: string;
  readonly table: Table;
  readonly revision: number;
  readonly now?: () => number;
  readonly historyPolicy?: HistoryPolicy;
  readonly coalescing?: CoalescingPolicy;
  readonly undoLimit?: number;
  readonly restore?: ClientSession;
}

/** Locally persisted session: pending requests (with original sent bytes), retained intent, and history handles. */
export interface ClientSession {
  readonly format: "sdl.client-session/1";
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly revision: number;
  readonly pending: readonly PendingEntry[];
  readonly retained: readonly RetainedIntent[];
  readonly history: HistoryExport;
}

export type TransactResult =
  | {
      readonly status: "applied";
      readonly request: RequestId;
      readonly group: string;
      readonly packedInto?: RequestId;
    }
  | { readonly status: "empty" | "queued" };

export interface ClientStatus {
  readonly confirmedRevision: number;
  readonly inFlight: RequestId | undefined;
  readonly unsent: readonly RequestId[];
  readonly doomed: readonly RequestId[];
  readonly retained: readonly RetainedIntent[];
  /** Incoming transitions integrated on the forward paired path versus private recovery. */
  readonly integrations: { readonly forward: number; readonly recovery: number };
}
