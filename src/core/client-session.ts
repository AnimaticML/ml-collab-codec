import type { SyncState } from "./client-state.ts";
import type { ClientOptions, ClientSession } from "./client-types.ts";
import type { HistoryExport } from "./history.ts";
import { ProtocolError } from "./protocol.ts";

/** A session attaches only to its own document, epoch, revision, actor, and schema. */
export function checkSession(session: ClientSession, options: ClientOptions): void {
  if (session.format !== "sdl.client-session/2")
    throw new ProtocolError("unsupportedProfile", "unsupported client session format");
  if (
    session.documentId !== options.documentId ||
    session.historyEpoch !== options.historyEpoch ||
    session.revision !== options.revision
  )
    throw new ProtocolError(
      "wrongDocument",
      "session belongs to a different document, epoch, or revision",
    );
  if (session.actor !== options.actor)
    throw new ProtocolError("notAuthorized", "a session can only be restored by its own actor");
  const schema = options.schemaRef;
  if (
    session.schema !== undefined &&
    schema !== undefined &&
    (session.schema.id !== schema.id || session.schema.version !== schema.version)
  )
    throw new ProtocolError("unsupportedContext", "session was saved under a different schema");
}

/** The locally persisted session: pending requests with original bytes, retained intent, own history. */
export function exportSession(
  options: ClientOptions,
  state: SyncState,
  history: HistoryExport,
): ClientSession {
  const { documentId, historyEpoch, actor, schemaRef } = options;
  return JSON.parse(
    JSON.stringify({
      format: "sdl.client-session/2",
      actor,
      ...(schemaRef === undefined ? {} : { schema: schemaRef }),
      documentId,
      historyEpoch,
      revision: state.revision,
      pending: state.pending,
      retained: state.retained,
      history,
    }),
  ) as ClientSession;
}
