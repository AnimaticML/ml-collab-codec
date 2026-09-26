import { OPERATION_FORMAT } from "./change.ts";
import type { AuthorityOptions, AuthorityState, DecisionRecord } from "./authority.ts";
import { Authority } from "./authority.ts";
import { decodeLedger, decodeRecord, decodeRetained } from "./checkpoint-decode.ts";
import { nonNegativeInt, DecodeError } from "./change-codec.ts";
import type { LedgerExport } from "./ledger.ts";
import type { TransitionEvent } from "./protocol.ts";
import { CONTROL_PROFILE } from "./protocol.ts";
import type { SchemaRef } from "./client-types.ts";
import type { SchemaProfile } from "./schema.ts";
import { readRows, SnapshotError, sortedRows } from "./snapshot-rows.ts";
import type { TableNode } from "./table.ts";

export const CHECKPOINT_FORMAT = "sdl.checkpoint/1";

/**
 * A collaboration checkpoint at accepted revision V (v3 §8.4): the snapshot
 * rows with their internal handles, document/history identity, versions,
 * retained complete transitions ending at V (for late rebasing and exact
 * backward traversal), and exact receipts plus expiry evidence. The retained
 * transitions are already included in the rows; they are never a tail to
 * replay. A checkpoint is trusted server state: never send it to a
 * participant (use a bootstrap snapshot instead).
 */
export interface CheckpointBundle {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly profile: typeof CONTROL_PROFILE;
  readonly opFormat: typeof OPERATION_FORMAT;
  readonly schema: SchemaRef;
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly revision: number;
  readonly rows: readonly TableNode[];
  readonly transitions: readonly TransitionEvent[];
  readonly ledger: LedgerExport;
}

/** Retain the last `retainTransitions` transitions (default: none, a state-only checkpoint). */
export function exportCheckpoint(
  authority: Authority,
  schema: SchemaRef,
  retainTransitions = 0,
): CheckpointBundle {
  const state = authority.exportState();
  const keep = Math.min(state.transitions.length, Math.max(0, retainTransitions));
  return JSON.parse(
    JSON.stringify({
      format: CHECKPOINT_FORMAT,
      profile: CONTROL_PROFILE,
      opFormat: OPERATION_FORMAT,
      schema: { id: schema.id, version: schema.version },
      documentId: state.documentId,
      historyEpoch: state.historyEpoch,
      revision: state.revision,
      rows: sortedRows(state.table),
      transitions: state.transitions.slice(state.transitions.length - keep),
      ledger: state.ledger,
    }),
  ) as CheckpointBundle;
}

function isProfile(schema: SchemaRef | SchemaProfile): schema is SchemaProfile {
  return "components" in schema;
}

/** Header checks shared by checkpoints and bootstraps: format, profiles, schema, scope, revision. */
export function readHeader(
  value: unknown,
  format: string,
  schema: SchemaRef | SchemaProfile,
): { raw: Record<string, unknown>; documentId: string; historyEpoch: string; revision: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SnapshotError("a snapshot must be an object");
  const raw = value as Record<string, unknown>;
  if (raw["format"] !== format)
    throw new SnapshotError(`unsupported snapshot format ${String(raw["format"])}`);
  if (raw["profile"] !== CONTROL_PROFILE)
    throw new SnapshotError(`unsupported control profile ${String(raw["profile"])}`);
  if (raw["opFormat"] !== OPERATION_FORMAT)
    throw new SnapshotError(`unsupported operation format ${String(raw["opFormat"])}`);
  const declared = raw["schema"] as Partial<SchemaRef> | undefined;
  if (declared?.id !== schema.id || declared.version !== schema.version)
    throw new SnapshotError("snapshot schema differs from the expected schema interpretation");
  const { documentId, historyEpoch } = raw;
  if (typeof documentId !== "string" || documentId.length === 0)
    throw new SnapshotError("snapshot documentId is malformed");
  if (typeof historyEpoch !== "string" || historyEpoch.length === 0)
    throw new SnapshotError("snapshot historyEpoch is malformed");
  try {
    return { raw, documentId, historyEpoch, revision: nonNegativeInt(raw["revision"], "revision") };
  } catch (error) {
    if (error instanceof DecodeError) throw new SnapshotError(error.message);
    throw error;
  }
}

/**
 * Fail-closed, bounded import (MR32): unknown formats/profiles, a different
 * schema interpretation, malformed or inconsistent rows, schema-invalid
 * state (when a profile is supplied), noncontiguous or non-invertible
 * retained transitions, and malformed ledgers are rejected before any state
 * is constructed.
 */
export function importCheckpoint(
  value: unknown,
  schema: SchemaRef | SchemaProfile,
): AuthorityState {
  const { raw, documentId, historyEpoch, revision } = readHeader(value, CHECKPOINT_FORMAT, schema);
  const scope = { documentId, historyEpoch };
  const table = readRows(raw["rows"], isProfile(schema) ? schema : undefined);
  const transitions = decodeRetained(raw["transitions"], scope, revision, table);
  const ledger = decodeLedger(raw["ledger"], scope, revision);
  return { documentId, historyEpoch, table, revision, transitions, ledger };
}

/**
 * Restore checkpoint V plus its tail of decision records on any host; no
 * event before V is needed. Tail records are decoded strictly; one already
 * covered by the checkpoint cut is skipped, so a boundary decision is
 * applied exactly once, and a gap after V is refused.
 */
export function restoreAuthority(
  bundle: unknown,
  tail: readonly unknown[],
  schema: SchemaRef | SchemaProfile,
  options: AuthorityOptions = {},
): Authority {
  const state = importCheckpoint(bundle, schema);
  const scope = { documentId: state.documentId, historyEpoch: state.historyEpoch };
  const records: DecisionRecord[] = tail.map((record, i) => decodeRecord(record, scope, i));
  const authority = new Authority(state, {
    ...(isProfile(schema) && options.schema === undefined ? { schema } : {}),
    ...options,
  });
  for (const record of records) {
    const covered =
      authority.hasReceipt(record.receipt.request) ||
      (record.transition !== undefined && record.transition.revision <= authority.getRevision());
    if (!covered) authority.replay(record);
  }
  return authority;
}
