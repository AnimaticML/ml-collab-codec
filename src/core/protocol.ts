import type { Change } from "./change.ts";
import { OPERATION_FORMAT } from "./change.ts";
import { canonicalJson, decodeChanges, DecodeError, nonNegativeInt } from "./change-codec.ts";
import type { RequestId } from "./identity.ts";
import { isReplicaId, isSequence } from "./identity.ts";

/** The one selected control profile: one logical authority, scalar confirmed prefix, paired IT. */
export const CONTROL_PROFILE = "sdl.scalar-prefix/1";

export type Outcome = "applied" | "alreadySatisfied" | "rejected";

/** Transaction/history metadata carried once per request, not per primitive (v3 §7.1). */
export interface RequestMeta {
  /** Undo group of the author's action (an explicit gesture, typing run, or agent task). */
  readonly group?: string;
  readonly undoOf?: string;
  readonly redoOf?: string;
  /** Confirmed revision the author read when the change was first authored. */
  readonly authoredRevision?: number;
  /** Local requests (sequences) the author's form depended on when authored. */
  readonly predecessors?: readonly number[];
  /** Sequences of further authored changes packed into this unsent request. */
  readonly packed?: readonly number[];
  /** Local wall-clock time for grouping/UI only; never used for ordering or deduplication. */
  readonly authoredAt?: number;
}

/** The immutable submitted form of a request: identity, submitted context, and payload. */
export interface RequestEnvelope {
  readonly profile: typeof CONTROL_PROFILE;
  readonly opFormat: typeof OPERATION_FORMAT;
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly replica: string;
  readonly seq: number;
  readonly baseRevision: number;
  readonly changes: readonly Change[];
  readonly meta: RequestMeta;
}

export interface TransitionEvent {
  readonly type: "transition";
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly revision: number;
  readonly request: RequestId;
  readonly actor: string;
  readonly meta: RequestMeta;
  readonly changes: readonly Change[];
}

export interface ReceiptEvent {
  readonly type: "receipt";
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly request: RequestId;
  readonly outcome: Outcome;
  /** Revision the decision was evaluated at (the state it saw). */
  readonly evaluatedRevision: number;
  /** Present only for `applied`: the revision its transition received. */
  readonly committedRevision?: number;
  readonly reason?: string;
}

export type ServerEvent = TransitionEvent | ReceiptEvent;

export type ProtocolErrorCode =
  | "unsupportedProfile"
  | "unsupportedContext"
  | "malformed"
  | "wrongDocument"
  | "payloadConflict"
  | "historyUnavailable"
  | "notAuthorized";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const ENVELOPE_KEYS = new Set([
  "profile",
  "opFormat",
  "documentId",
  "historyEpoch",
  "replica",
  "seq",
  "baseRevision",
  "changes",
  "meta",
]);
const META_KEYS = new Set([
  "group",
  "undoOf",
  "redoOf",
  "authoredRevision",
  "predecessors",
  "packed",
  "authoredAt",
]);

function sequences(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || !value.every(isSequence))
    throw new DecodeError(path, "expected request sequences");
  return value;
}

function decodeMeta(value: unknown): RequestMeta {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DecodeError("meta", "expected an object");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!META_KEYS.has(key))
      throw new ProtocolError("unsupportedContext", `unsupported request metadata ${key}`);
  const text = (key: string): Record<string, string> => {
    const item = raw[key];
    if (item === undefined) return {};
    if (typeof item !== "string" || item.length === 0)
      throw new DecodeError(`meta.${key}`, "expected a string");
    return { [key]: item };
  };
  return {
    ...text("group"),
    ...text("undoOf"),
    ...text("redoOf"),
    ...(raw["authoredRevision"] === undefined
      ? {}
      : { authoredRevision: nonNegativeInt(raw["authoredRevision"], "meta.authoredRevision") }),
    ...(raw["predecessors"] === undefined
      ? {}
      : { predecessors: sequences(raw["predecessors"], "meta.predecessors") }),
    ...(raw["packed"] === undefined ? {} : { packed: sequences(raw["packed"], "meta.packed") }),
    ...(raw["authoredAt"] === undefined
      ? {}
      : { authoredAt: nonNegativeInt(raw["authoredAt"], "meta.authoredAt") }),
  };
}

function requireText(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0)
    throw new ProtocolError("malformed", `${key} must be a non-empty string`);
  return value;
}

/**
 * Fail-closed request decoding (v3 §5.5, R53/R54): unknown profiles,
 * unknown context fields (for example a vector clock), presence envelopes,
 * and malformed records are rejected before any state is touched.
 */
export function decodeRequest(value: unknown): RequestEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolError("malformed", "a request must be an object");
  const raw = value as Record<string, unknown>;
  if (raw["profile"] !== CONTROL_PROFILE)
    throw new ProtocolError(
      "unsupportedProfile",
      `unsupported control profile ${String(raw["profile"])}`,
    );
  if (raw["opFormat"] !== OPERATION_FORMAT)
    throw new ProtocolError(
      "unsupportedProfile",
      `unsupported operation format ${String(raw["opFormat"])}`,
    );
  for (const key of Object.keys(raw))
    if (!ENVELOPE_KEYS.has(key))
      throw new ProtocolError("unsupportedContext", `unsupported request field ${key}`);
  const replica = raw["replica"];
  if (!isReplicaId(replica)) throw new ProtocolError("malformed", "invalid replica incarnation id");
  if (!isSequence(raw["seq"]))
    throw new ProtocolError("malformed", "request sequence must be a positive safe integer");
  try {
    return {
      profile: CONTROL_PROFILE,
      opFormat: OPERATION_FORMAT,
      documentId: requireText(raw, "documentId"),
      historyEpoch: requireText(raw, "historyEpoch"),
      replica,
      seq: raw["seq"],
      baseRevision: nonNegativeInt(raw["baseRevision"], "baseRevision"),
      changes: decodeChanges(raw["changes"]),
      meta: decodeMeta(raw["meta"]),
    };
  } catch (error) {
    if (error instanceof DecodeError) throw new ProtocolError("malformed", error.message);
    throw error;
  }
}

/** Canonical bytes of the immutable submitted request, used as its deduplication fingerprint. */
export function fingerprint(envelope: RequestEnvelope): string {
  return canonicalJson(envelope);
}
