import { applyChanges } from "./apply.ts";
import type { Authority } from "./authority.ts";
import { invertChanges, OPERATION_FORMAT } from "./change.ts";
import type { CheckpointBundle } from "./checkpoint.ts";
import { readHeader } from "./checkpoint.ts";
import { Client } from "./client.ts";
import type { ClientOptions, ClientSession, SchemaRef } from "./client-types.ts";
import type { TransitionEvent } from "./protocol.ts";
import { CONTROL_PROFILE, ProtocolError } from "./protocol.ts";
import { decodeTransition } from "./protocol-events.ts";
import type { SchemaProfile } from "./schema.ts";
import { readRows, SnapshotError, sortedRows } from "./snapshot-rows.ts";
import type { Table, TableNode } from "./table.ts";

export const BOOTSTRAP_FORMAT = "sdl.bootstrap/1";

/**
 * A participant's join snapshot at accepted revision V: the operational rows
 * (internal text/anonymous handles preserved, never regenerated from
 * source), document/history identity, versions, and the scope it was
 * projected for. It carries no transitions, receipts, other actors' inverse
 * payloads, or undo history: a snapshot is state, not a log.
 */
export interface Bootstrap {
  readonly format: typeof BOOTSTRAP_FORMAT;
  readonly profile: typeof CONTROL_PROFILE;
  readonly opFormat: typeof OPERATION_FORMAT;
  readonly schema: SchemaRef;
  readonly documentId: string;
  readonly historyEpoch: string;
  readonly revision: number;
  /** `full` for an unrestricted participant, otherwise the principal the rows were projected for. */
  readonly scope:
    { readonly kind: "full" } | { readonly kind: "restricted"; readonly principal: string };
  readonly rows: readonly TableNode[];
}

type Scope = Bootstrap["scope"];

function bootstrapOf(
  state: { documentId: string; historyEpoch: string; revision: number; table: Table },
  schema: SchemaRef,
  scope: Scope,
): Bootstrap {
  return JSON.parse(
    JSON.stringify({
      format: BOOTSTRAP_FORMAT,
      profile: CONTROL_PROFILE,
      opFormat: OPERATION_FORMAT,
      schema: { id: schema.id, version: schema.version },
      documentId: state.documentId,
      historyEpoch: state.historyEpoch,
      revision: state.revision,
      scope,
      rows: sortedRows(state.table),
    }),
  ) as Bootstrap;
}

/** Capture the current accepted state as a bootstrap (the authority is not changed). */
export function captureBootstrap(
  source: Pick<Authority, "scope" | "getTable" | "getRevision">,
  schema: SchemaRef,
  view?: { readonly principal: string; readonly table: Table },
): Bootstrap {
  return bootstrapOf(
    { ...source.scope(), revision: source.getRevision(), table: view?.table ?? source.getTable() },
    schema,
    view === undefined ? { kind: "full" } : { kind: "restricted", principal: view.principal },
  );
}

/** A stored checkpoint's state as a bootstrap (its retained history and ledger are dropped). */
export function bootstrapFromCheckpoint(bundle: CheckpointBundle): Bootstrap {
  return {
    format: BOOTSTRAP_FORMAT,
    profile: bundle.profile,
    opFormat: bundle.opFormat,
    schema: bundle.schema,
    documentId: bundle.documentId,
    historyEpoch: bundle.historyEpoch,
    revision: bundle.revision,
    scope: { kind: "full" },
    rows: bundle.rows,
  };
}

/**
 * Join fence (race-free handoff): subscribe to accepted transitions first,
 * then capture the snapshot. Every transition after the snapshot revision
 * reaches `deliver`; ones at or below it are harmless duplicates the client
 * ignores. Call `stop` when the participant leaves.
 */
export function beginJoin(
  authority: Authority,
  schema: SchemaRef,
  deliver: (transition: TransitionEvent) => void,
): { readonly bootstrap: Bootstrap; readonly stop: () => void } {
  const stop = authority.subscribe(deliver);
  return { bootstrap: captureBootstrap(authority, schema), stop };
}

/** Strict read of a bootstrap: header, scope, and rows (schema-validated when a profile is given). */
export function readBootstrap(
  value: unknown,
  schema: SchemaRef | SchemaProfile,
): { documentId: string; historyEpoch: string; revision: number; scope: Scope; table: Table } {
  const { raw, documentId, historyEpoch, revision } = readHeader(value, BOOTSTRAP_FORMAT, schema);
  const scope = raw["scope"] as Partial<{ kind: string; principal: string }> | undefined;
  if (!(
    scope?.kind === "full" ||
    (scope?.kind === "restricted" && typeof scope.principal === "string")
  ))
    throw new SnapshotError("bootstrap scope is malformed");
  const profile = "components" in schema ? schema : undefined;
  // A restricted projection omits hidden rows, so it is structurally checked but not schema-validated.
  const table = readRows(raw["rows"], scope.kind === "full" ? profile : undefined);
  return { documentId, historyEpoch, revision, scope: scope as Scope, table };
}

export type JoinOptions = Omit<
  ClientOptions,
  "documentId" | "historyEpoch" | "table" | "revision" | "restore" | "historyStatus"
> & {
  readonly bootstrap: unknown;
  readonly schema: SchemaRef | SchemaProfile;
  /** Accepted transitions around the snapshot (the catch-up tail, and any context a session needs). */
  readonly transitions?: readonly unknown[];
  /** The actor's own persisted session, if the host kept one (see `SessionStore`). */
  readonly restore?: ClientSession;
};

/**
 * Host-side port for actor-scoped session persistence across devices or
 * restarts. The library prescribes no storage; a host that wants historic
 * own undo on a new device saves `client.exportSession()` and supplies it
 * to `joinClient` for the same authenticated actor.
 */
export interface SessionStore {
  load(documentId: string, actor: string): Promise<ClientSession | undefined>;
  save(session: ClientSession): Promise<void>;
}

/** State at revision `target` from state V and the contiguous transitions between them, if available. */
function stateAt(
  table: Table,
  revision: number,
  target: number,
  byRevision: ReadonlyMap<number, TransitionEvent>,
): Table | undefined {
  const low = Math.min(revision, target);
  const high = Math.max(revision, target);
  const between: TransitionEvent[] = [];
  for (let r = low + 1; r <= high; r += 1) {
    const transition = byRevision.get(r);
    if (transition === undefined) return undefined;
    between.push(transition);
  }
  const changes = between.flatMap((transition) => transition.changes);
  return applyChanges(table, target < revision ? invertChanges(changes) : changes);
}

/** A session whose context is gone: pending work is kept as retained intent, history is not attached. */
function unavailableSession(
  session: ClientSession,
  revision: number,
  reason: string,
): ClientSession {
  return {
    ...session,
    revision,
    pending: [],
    retained: [
      ...session.retained,
      ...session.pending.map((entry) => ({
        id: entry.id,
        meta: entry.meta,
        working: entry.working,
        status: "resync" as const,
        reason,
      })),
    ],
    history: { revision, groups: [], redoStack: [], nextOrder: session.history.nextOrder },
  };
}

/**
 * Join a document from a bootstrap snapshot plus accepted transitions.
 * Without a session the client starts at V with empty history. A session at
 * U is restored in its own context: state U is reconstructed from V and the
 * supplied transitions between U and V (forward, or backward through the
 * self-contained inverses), the session attaches there, and every later
 * transition integrates through the normal protocol path. If that context
 * is not supplied, history is reported unavailable and pending work becomes
 * retained intent; nothing is guessed.
 */
export function joinClient(options: JoinOptions): Client {
  const { bootstrap, schema, transitions = [], restore, ...clientOptions } = options;
  const snap = readBootstrap(bootstrap, schema);
  const scope = { documentId: snap.documentId, historyEpoch: snap.historyEpoch };
  const decoded = transitions.map((raw) => decodeTransition(raw, scope));
  const byRevision = new Map(decoded.map((transition) => [transition.revision, transition]));
  const base = {
    ...clientOptions,
    ...scope,
    schemaRef: { id: schema.id, version: schema.version },
  };
  let client: Client;
  if (restore === undefined) {
    client = new Client({ ...base, table: snap.table, revision: snap.revision });
  } else {
    // Identity, actor, and schema are checked by the client before anything attaches.
    if (restore.documentId !== scope.documentId || restore.historyEpoch !== scope.historyEpoch)
      throw new ProtocolError("wrongDocument", "session belongs to a different document or epoch");
    const at = stateAt(snap.table, snap.revision, restore.revision, byRevision);
    client =
      at === undefined
        ? new Client({
            ...base,
            table: snap.table,
            revision: snap.revision,
            restore: unavailableSession(restore, snap.revision, "session context is not retained"),
            historyStatus: { status: "unavailable", reason: "session context is not retained" },
          })
        : new Client({ ...base, table: at, revision: restore.revision, restore });
  }
  const later = decoded.filter((transition) => transition.revision > client.state.revision);
  if (later.length > 0) client.receive(later);
  return client;
}
