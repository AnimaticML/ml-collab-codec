import type { Change } from "./change.ts";
import type { Exclusion } from "./client-queue.ts";
import { liveChain } from "./client-queue.ts";
import { exclude } from "./client-state.ts";
import type { Client } from "./client.ts";
import type { GroupRecord, Handle } from "./history.ts";
import type { RequestId } from "./identity.ts";
import { requestKey } from "./identity.ts";
import { ApplyError } from "./staging.ts";
import { isConflict, transformPair } from "./transform.ts";

/**
 * Outcome of an undo/redo command. `requested` enqueued a new request linked
 * to the group; `deferred` waits for an in-flight member's receipt;
 * `cancelledLocally` removed only unsent work; the rest change nothing.
 */
export type UndoResult =
  | {
      readonly status: "requested";
      readonly group: string;
      readonly request: RequestId;
      readonly dropped: number;
    }
  | { readonly status: "cancelledLocally" | "deferred" | "pending"; readonly group: string }
  | { readonly status: "noRemainingEffect"; readonly group: string; readonly dropped: number }
  | { readonly status: "conflict"; readonly group: string; readonly reason: string }
  | { readonly status: "unavailable"; readonly group?: string };

function submitHandle(
  client: Client,
  group: GroupRecord,
  handle: Handle,
  relation: "undoOf" | "redoOf",
): UndoResult {
  if ("conflict" in handle) return { status: "conflict", group: group.id, reason: handle.conflict };
  if (handle.changes.length === 0) {
    client.history.markSpent(group.id);
    return { status: "noRemainingEffect", group: group.id, dropped: handle.dropped };
  }
  const rebased = transformPair(handle.changes, liveChain(client.state.pending));
  if (isConflict(rebased))
    return {
      status: "conflict",
      group: group.id,
      reason: `conflicts with pending local work: ${rebased.detail}`,
    };
  let result;
  try {
    result = client.author(
      (builder) => rebased.a.forEach((change: Change) => builder.record(change)),
      { [relation]: group.id },
      relation === "undoOf" ? "undo" : "redo",
    );
  } catch (error) {
    if (error instanceof ApplyError)
      return { status: "conflict", group: group.id, reason: error.code };
    throw error;
  }
  if (result.status !== "applied")
    return { status: "noRemainingEffect", group: group.id, dropped: handle.dropped };
  client.history.setPending(group.id, result.request.seq);
  return { status: "requested", group: group.id, request: result.request, dropped: handle.dropped };
}

/**
 * Collaborative undo of an own group (v3 §8): unsent members are cancelled
 * locally, an in-flight member defers the undo until its outcome is known,
 * and confirmed members are cancelled by a new request built from the
 * group's current-context handle rebased over pending local work.
 */
export function runUndo(client: Client, target?: string): UndoResult {
  const group = target === undefined ? client.history.latestUndoable() : client.history.get(target);
  if (group === undefined)
    return target === undefined
      ? { status: "unavailable" }
      : { status: "unavailable", group: target };
  if (group.state !== "active") return { status: "unavailable", group: group.id };
  if (group.pendingRequest !== undefined) return { status: "pending", group: group.id };
  const members = client.state.pending.filter((entry) => entry.meta.group === group.id);
  if (members.some((entry) => entry.state !== "unsent")) {
    client.deferUndo(group.id);
    return { status: "deferred", group: group.id };
  }
  if (members.length > 0) {
    const drops = new Map<string, Exclusion>(
      members.map((entry) => [requestKey(entry.id), { kind: "drop" }]),
    );
    client.commitStep(exclude(client.state, drops), "undo");
    const confirmedMembers = group.members.length - members.length;
    if (confirmedMembers === 0 || ("changes" in group.undo && group.undo.changes.length === 0)) {
      client.history.markSpent(group.id);
      return { status: "cancelledLocally", group: group.id };
    }
  }
  return submitHandle(client, group, group.undo, "undoOf");
}

export function runRedo(client: Client, target?: string): UndoResult {
  const group = target === undefined ? client.history.latestRedoable() : client.history.get(target);
  if (group === undefined)
    return target === undefined
      ? { status: "unavailable" }
      : { status: "unavailable", group: target };
  if (group.state !== "undone" || group.redo === undefined)
    return { status: "unavailable", group: group.id };
  if (group.pendingRequest !== undefined) return { status: "pending", group: group.id };
  return submitHandle(client, group, group.redo, "redoOf");
}
