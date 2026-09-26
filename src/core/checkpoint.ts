import { OPERATION_FORMAT } from "./change.ts";
import { decodeChanges, DecodeError, jsonValue } from "./change-codec.ts";
import type { AuthorityOptions, AuthorityState, DecisionRecord } from "./authority.ts";
import { Authority } from "./authority.ts";
import type { LedgerExport } from "./ledger.ts";
import type { TransitionEvent } from "./protocol.ts";
import { CONTROL_PROFILE } from "./protocol.ts";
import type { Table, TableNode } from "./table.ts";
import { makeRow } from "./table.ts";
import type { JsonObject } from "./types.ts";

export const CHECKPOINT_FORMAT = "sdl.checkpoint/1";

/**
 * A collaboration checkpoint at accepted revision V (v3 §8.4): the snapshot
 * rows with their internal handles, document/history identity, versions,
 * retained complete transitions ending at V (for late rebasing and exact
 * backward traversal), and exact receipts plus expiry evidence. It does not
 * reset request sequences, origins, or the history epoch.
 */
export interface CheckpointBundle {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly profile: typeof CONTROL_PROFILE;
  readonly opFormat: typeof OPERATION_FORMAT;
  readonly schema: { readonly id: string; readonly version: string };
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly revision: number;
  readonly rows: readonly TableNode[];
  readonly transitions: readonly TransitionEvent[];
  readonly ledger: LedgerExport;
}

export class CheckpointError extends Error {}

export function exportCheckpoint(
  authority: Authority,
  schema: { id: string; version: string },
  retainTransitions = Infinity,
): CheckpointBundle {
  const state = authority.exportState();
  const keep = Math.min(state.transitions.length, retainTransitions);
  const rows = [...state.table.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.parse(
    JSON.stringify({
      format: CHECKPOINT_FORMAT,
      profile: CONTROL_PROFILE,
      opFormat: OPERATION_FORMAT,
      schema,
      documentId: state.documentId,
      historyEpoch: state.historyEpoch,
      revision: state.revision,
      rows,
      transitions: state.transitions.slice(state.transitions.length - keep),
      ledger: state.ledger,
    }),
  ) as CheckpointBundle;
}

function rowsToTable(rows: readonly TableNode[]): Table {
  const table = new Map<string, TableNode>();
  for (const [i, row] of rows.entries()) {
    const props = jsonValue(row.props, `rows[${i}].props`) as JsonObject;
    if (typeof row.id !== "string" || typeof row.tag !== "string" || !Array.isArray(row.children))
      throw new CheckpointError(`rows[${i}] is malformed`);
    table.set(
      row.id,
      makeRow(row.id, row.tag, props, row.parentId, row.children, row.persisted === true),
    );
  }
  return table;
}

/**
 * Fail-closed import: unknown formats, control/operation profiles, or an
 * unexpected schema are rejected before any state is constructed.
 */
export function importCheckpoint(
  value: unknown,
  expectedSchema: { id: string; version: string },
): AuthorityState {
  const bundle = value as Partial<CheckpointBundle>;
  if (bundle.format !== CHECKPOINT_FORMAT)
    throw new CheckpointError(`unsupported checkpoint format ${String(bundle.format)}`);
  if (bundle.profile !== CONTROL_PROFILE)
    throw new CheckpointError(`unsupported control profile ${String(bundle.profile)}`);
  if (bundle.opFormat !== OPERATION_FORMAT)
    throw new CheckpointError(`unsupported operation format ${String(bundle.opFormat)}`);
  if (bundle.schema?.id !== expectedSchema.id || bundle.schema.version !== expectedSchema.version)
    throw new CheckpointError("checkpoint schema differs from the expected schema interpretation");
  if (
    typeof bundle.documentId !== "string" ||
    typeof bundle.historyEpoch !== "string" ||
    typeof bundle.revision !== "number"
  )
    throw new CheckpointError("checkpoint identity is malformed");
  try {
    const transitions = (bundle.transitions ?? []).map((t, i) => ({
      ...t,
      changes: decodeChanges(t.changes, `transitions[${i}].changes`),
    }));
    transitions.forEach((t, i) => {
      if (t.revision !== (bundle.revision ?? 0) - transitions.length + i + 1)
        throw new CheckpointError("retained transitions are not contiguous");
    });
    const ledger = bundle.ledger ?? { receipts: [], replicas: [], groups: [] };
    return {
      documentId: bundle.documentId,
      historyEpoch: bundle.historyEpoch,
      table: rowsToTable(bundle.rows ?? []),
      revision: bundle.revision,
      transitions,
      ledger,
    };
  } catch (error) {
    if (error instanceof DecodeError) throw new CheckpointError(error.message);
    throw error;
  }
}

/** Restore checkpoint V plus its tail of decision records on any host; no event before V is needed. */
export function restoreAuthority(
  bundle: unknown,
  tail: readonly DecisionRecord[],
  schema: { id: string; version: string },
  options: AuthorityOptions = {},
): Authority {
  const authority = new Authority(importCheckpoint(bundle, schema), options);
  // A record already covered by the checkpoint cut is skipped, so a boundary decision is applied exactly once.
  for (const record of tail) {
    const covered =
      authority.hasReceipt(record.receipt.request) ||
      (record.transition !== undefined && record.transition.revision <= authority.getRevision());
    if (!covered) authority.replay(record);
  }
  return authority;
}
