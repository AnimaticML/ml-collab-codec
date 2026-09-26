import type { Change } from "../../src/core/change.ts";
import { OPERATION_FORMAT } from "../../src/core/change.ts";
import { ChangeBuilder } from "../../src/core/builder.ts";
import type { RequestEnvelope, RequestMeta } from "../../src/core/protocol.ts";
import { CONTROL_PROFILE } from "../../src/core/protocol.ts";
import type { Table } from "../../src/core/table.ts";
import { DOC, EPOCH } from "./room.ts";

/** Build complete records with the real builder, authored by (replica, seq) in `table`. */
export function build(
  table: Table,
  replica: string,
  seq: number,
  commands: (builder: ChangeBuilder) => void,
): Change[] {
  const builder = new ChangeBuilder(table, { replica, seq });
  commands(builder);
  return [...builder.changes];
}

/** A request envelope as a client would submit it. */
export function envelope(
  replica: string,
  seq: number,
  baseRevision: number,
  changes: readonly Change[],
  meta: RequestMeta = {},
): RequestEnvelope {
  return {
    profile: CONTROL_PROFILE,
    opFormat: OPERATION_FORMAT,
    documentId: DOC,
    historyEpoch: EPOCH,
    replica,
    seq,
    baseRevision,
    changes,
    meta,
  };
}
