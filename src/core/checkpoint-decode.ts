import { applyChanges } from "./apply.ts";
import { invertChanges } from "./change.ts";
import { DecodeError, nonNegativeInt } from "./change-codec.ts";
import type { DecisionRecord } from "./authority-types.ts";
import { isReplicaId } from "./identity.ts";
import type { LedgerExport } from "./ledger.ts";
import type { TransitionEvent } from "./protocol.ts";
import { ProtocolError } from "./protocol.ts";
import { decodeReceipt, decodeTransition } from "./protocol-events.ts";
import { SnapshotError } from "./snapshot-rows.ts";
import { ApplyError } from "./staging.ts";
import type { Table } from "./table.ts";

type Scope = { readonly documentId: string; readonly historyEpoch: string };

/** Total primitives a checkpoint may carry in retained transitions (bounded restore work). */
const MAX_RETAINED_CHANGES = 1_000_000;

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError(`${path} must be an array`);
  return value;
}

function fields(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SnapshotError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new SnapshotError(`${path} must be a non-empty string`);
  return value;
}

function count(value: unknown, path: string): number {
  try {
    return nonNegativeInt(value, path);
  } catch (error) {
    if (error instanceof DecodeError) throw new SnapshotError(error.message);
    throw error;
  }
}

/** Protocol decode failures inside a snapshot are snapshot corruption. */
function snapshotSafe<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof ProtocolError) throw new SnapshotError(error.message);
    throw error;
  }
}

/**
 * Retained transitions: decoded, in scope, contiguous, ending exactly at the
 * snapshot revision, bounded, and invertible from the snapshot state (so a
 * retained record that does not describe how state V was reached fails).
 */
export function decodeRetained(
  value: unknown,
  scope: Scope,
  revision: number,
  table: Table,
): TransitionEvent[] {
  const transitions = list(value ?? [], "transitions").map((raw) =>
    snapshotSafe(() => decodeTransition(raw, scope)),
  );
  transitions.forEach((t, i) => {
    if (t.revision !== revision - transitions.length + i + 1)
      throw new SnapshotError("retained transitions are not contiguous up to the revision");
  });
  const all = transitions.flatMap((t) => t.changes);
  if (all.length > MAX_RETAINED_CHANGES) throw new SnapshotError("too many retained primitives");
  try {
    applyChanges(table, invertChanges(all));
  } catch (error) {
    if (error instanceof ApplyError)
      throw new SnapshotError(`retained transitions do not lead to this state: ${error.code}`);
    throw error;
  }
  return transitions;
}

export function decodeLedger(value: unknown, scope: Scope, revision: number): LedgerExport {
  const raw = fields(value ?? { receipts: [], replicas: [], groups: [] }, "ledger");
  const keys = new Set<string>();
  const receipts = list(raw["receipts"], "ledger.receipts").map((item, i) => {
    const entry = fields(item, `ledger.receipts[${i}]`);
    const receipt = snapshotSafe(() => decodeReceipt(entry["receipt"], scope));
    const key = `${receipt.request.replica}#${receipt.request.seq}`;
    if (keys.has(key)) throw new SnapshotError(`duplicate receipt for ${key}`);
    keys.add(key);
    if (receipt.evaluatedRevision > revision || (receipt.committedRevision ?? 0) > revision)
      throw new SnapshotError(`receipt ${key} is newer than the checkpoint`);
    return {
      fingerprint: name(entry["fingerprint"], `ledger.receipts[${i}].fingerprint`),
      receipt,
    };
  });
  const replicas = list(raw["replicas"], "ledger.replicas").map((item, i) => {
    const entry = fields(item, `ledger.replicas[${i}]`);
    if (!isReplicaId(entry["replica"])) throw new SnapshotError("invalid replica id in ledger");
    return {
      replica: entry["replica"],
      actor: name(entry["actor"], `ledger.replicas[${i}].actor`),
      highestSeq: count(entry["highestSeq"], `ledger.replicas[${i}].highestSeq`),
      expiredThrough: count(entry["expiredThrough"], `ledger.replicas[${i}].expiredThrough`),
    };
  });
  const groups = list(raw["groups"], "ledger.groups").map((item, i) => {
    const entry = fields(item, `ledger.groups[${i}]`);
    return {
      group: name(entry["group"], `ledger.groups[${i}].group`),
      actor: name(entry["actor"], `ledger.groups[${i}].actor`),
    };
  });
  return { receipts, replicas, groups };
}

/** A durably logged decision read back from storage. */
export function decodeRecord(value: unknown, scope: Scope, i: number): DecisionRecord {
  const raw = fields(value, `tail[${i}]`);
  const transition =
    raw["transition"] === undefined
      ? undefined
      : snapshotSafe(() => decodeTransition(raw["transition"], scope));
  return {
    actor: name(raw["actor"], `tail[${i}].actor`),
    fingerprint: name(raw["fingerprint"], `tail[${i}].fingerprint`),
    receipt: snapshotSafe(() => decodeReceipt(raw["receipt"], scope)),
    ...(transition === undefined ? {} : { transition }),
  };
}
