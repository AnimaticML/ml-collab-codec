import type { CoalescingPolicy, HistoryPolicy } from "./grouping.ts";
import type { HistoryExport } from "./history.ts";
import type { PendingEntry, RetainedIntent } from "./client-queue.ts";
import type { RequestId, SequenceAllocator } from "./identity.ts";
import type { Table } from "./table.ts";

/** The schema interpretation a snapshot or session was produced under. */
export interface SchemaRef {
  readonly id: string;
  readonly version: string;
}

/**
 * Whether this client holds own undo history, and why not: `empty` for a
 * fresh participant (a snapshot carries no history), `restored` for a
 * session attached in its own context, `unavailable` when the session's
 * context was gone (pending work became retained intent).
 */
export type HistoryStatus =
  | { readonly status: "empty" }
  | { readonly status: "restored"; readonly revision: number }
  | { readonly status: "unavailable"; readonly reason: string };

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
  /**
   * Optional cap on accepted transitions kept so that an own group's undo,
   * broken by a later own group, recovers once that group is undone.
   * Default: unbounded (the log is trimmed to what retained groups can use,
   * so `undoLimit` bounds it). A smaller value saves memory and session size;
   * a recovery older than the cap ends as a final conflict.
   */
  readonly recoveryLimit?: number;
  readonly restore?: ClientSession;
  /** The schema interpretation, recorded in exported sessions and checked on restore. */
  readonly schemaRef?: SchemaRef;
  /** Set by `joinClient` when a supplied session could not be attached in its context. */
  readonly historyStatus?: HistoryStatus;
}

/** Locally persisted session: pending requests (with original sent bytes), retained intent, and history handles. */
export interface ClientSession {
  readonly format: "sdl.client-session/2";
  /** The authenticated actor that owns this history; only that actor may restore it. */
  readonly actor: string;
  readonly schema?: SchemaRef;
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
  readonly history: HistoryStatus;
}
