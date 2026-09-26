import { decodeChanges, DecodeError, nonNegativeInt } from "./change-codec.ts";
import { isReplicaId, isSequence } from "./identity.ts";
import type { RequestId } from "./identity.ts";
import type { Outcome, ReceiptEvent, TransitionEvent } from "./protocol.ts";
import { decodeMeta, ProtocolError } from "./protocol.ts";

const OUTCOMES: readonly Outcome[] = ["applied", "alreadySatisfied", "rejected"];

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolError("malformed", `${what} must be an object`);
  return value as Record<string, unknown>;
}

function scopeText(raw: Record<string, unknown>, key: string, expected: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0)
    throw new ProtocolError("malformed", `${key} must be a non-empty string`);
  if (value !== expected)
    throw new ProtocolError("wrongDocument", "event belongs to a different document or epoch");
  return value;
}

function requestId(value: unknown): RequestId {
  const raw = record(value, "request");
  if (!isReplicaId(raw["replica"]) || !isSequence(raw["seq"]))
    throw new ProtocolError("malformed", "invalid request id");
  return { replica: raw["replica"], seq: raw["seq"] };
}

function guarded<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof DecodeError) throw new ProtocolError("malformed", error.message);
    throw error;
  }
}

type Scope = { readonly documentId: string; readonly historyEpoch: string };

/** Fail-closed decoding of an accepted transition received from storage or a transport. */
export function decodeTransition(value: unknown, scope: Scope): TransitionEvent {
  const raw = record(value, "transition");
  if (raw["type"] !== "transition") throw new ProtocolError("malformed", "expected a transition");
  const actor = raw["actor"];
  if (typeof actor !== "string" || actor.length === 0)
    throw new ProtocolError("malformed", "transition actor must be a non-empty string");
  return guarded(() => {
    const revision = nonNegativeInt(raw["revision"], "revision");
    if (revision < 1) throw new DecodeError("revision", "a transition revision is at least 1");
    return {
      type: "transition",
      documentId: scopeText(raw, "documentId", scope.documentId),
      historyEpoch: scopeText(raw, "historyEpoch", scope.historyEpoch),
      revision,
      request: requestId(raw["request"]),
      actor,
      meta: decodeMeta(raw["meta"]),
      changes: decodeChanges(raw["changes"]),
    };
  });
}

/** Fail-closed decoding of a stored terminal receipt. */
export function decodeReceipt(value: unknown, scope: Scope): ReceiptEvent {
  const raw = record(value, "receipt");
  if (raw["type"] !== "receipt") throw new ProtocolError("malformed", "expected a receipt");
  const outcome = raw["outcome"];
  if (!OUTCOMES.includes(outcome as Outcome))
    throw new ProtocolError("malformed", "unknown receipt outcome");
  const reason = raw["reason"];
  if (reason !== undefined && typeof reason !== "string")
    throw new ProtocolError("malformed", "receipt reason must be a string");
  return guarded(() => {
    const committed = raw["committedRevision"];
    if ((outcome === "applied") !== (committed !== undefined))
      throw new DecodeError("committedRevision", "present exactly for applied receipts");
    return {
      type: "receipt",
      documentId: scopeText(raw, "documentId", scope.documentId),
      historyEpoch: scopeText(raw, "historyEpoch", scope.historyEpoch),
      request: requestId(raw["request"]),
      outcome: outcome as Outcome,
      evaluatedRevision: nonNegativeInt(raw["evaluatedRevision"], "evaluatedRevision"),
      ...(committed === undefined
        ? {}
        : { committedRevision: nonNegativeInt(committed, "committedRevision") }),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}
