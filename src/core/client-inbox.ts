import { canonicalJson } from "./change-codec.ts";
import { applyChanges } from "./apply.ts";
import type { Exclusion } from "./client-queue.ts";
import { exclude, integrate } from "./client-state.ts";
import type { Client } from "./client.ts";
import { requestKey, sameRequest } from "./identity.ts";
import type { ReceiptEvent, ServerEvent, TransitionEvent } from "./protocol.ts";

/**
 * Ordered integration of server events (v3 §5.3/§5.7): effectful
 * transitions apply in contiguous revision order (gaps are buffered, stale
 * duplicates ignored); a terminal receipt is processed once the client has
 * reached the revision it was evaluated at. Receipts never create revisions.
 */
export class Inbox {
  private readonly buffered = new Map<number, TransitionEvent>();
  private receipts: ReceiptEvent[] = [];

  accept(events: readonly ServerEvent[], revision: number): void {
    for (const event of events) {
      if (event.type === "transition" && event.revision > revision)
        this.buffered.set(event.revision, event);
      if (event.type === "receipt") this.receipts.push(event);
    }
  }

  drain(client: Client): void {
    for (let progress = true; progress;) {
      progress = false;
      const ready = this.receipts.filter(
        (receipt) => receipt.evaluatedRevision <= client.state.revision,
      );
      this.receipts = this.receipts.filter((receipt) => !ready.includes(receipt));
      for (const receipt of ready) onReceipt(client, receipt);
      const next = this.buffered.get(client.state.revision + 1);
      if (next !== undefined) {
        this.buffered.delete(next.revision);
        onTransition(client, next);
        progress = true;
      }
    }
    for (const revision of this.buffered.keys())
      if (revision <= client.state.revision) this.buffered.delete(revision);
  }

  clear(): void {
    this.buffered.clear();
    this.receipts = [];
  }

  /** Revisions received ahead of a gap, waiting for the missing transition. */
  waiting(): number[] {
    return [...this.buffered.keys()].sort((a, b) => a - b);
  }
}

function onTransition(client: Client, transition: TransitionEvent): void {
  const own = client.state.pending.find((entry) => sameRequest(entry.id, transition.request));
  if (
    own !== undefined &&
    own === client.state.pending[0] &&
    own.state === "inFlight" &&
    canonicalJson(own.working) === canonicalJson(transition.changes)
  ) {
    const confirmed = applyChanges(client.state.confirmed, transition.changes);
    client.history.onTransition(transition, true);
    const state = {
      ...client.state,
      confirmed,
      revision: transition.revision,
      pending: client.state.pending.slice(1),
    };
    client.commitStep({ state, mapping: [] }, undefined, [
      `acknowledged ${requestKey(transition.request)}`,
    ]);
    return;
  }
  // An own request that was doomed or diverged locally is accepted content like any remote change.
  if (own !== undefined)
    client.commitStep(
      exclude(client.state, new Map<string, Exclusion>([[requestKey(own.id), { kind: "drop" }]])),
      "reconcile",
    );
  const step = integrate(
    client.state,
    transition.changes,
    transition.revision,
    client.state.pending,
  );
  client.history.onTransition(transition, own !== undefined);
  if (own === undefined) client.noteRemote();
  client.commitStep(step, own === undefined ? "remote" : "reconcile");
}

function onReceipt(client: Client, receipt: ReceiptEvent): void {
  const entry = client.state.pending.find((candidate) =>
    sameRequest(candidate.id, receipt.request),
  );
  if (entry === undefined || receipt.outcome === "applied") return;
  const how: Exclusion =
    receipt.outcome === "rejected"
      ? { kind: "retain", status: "rejected", reason: receipt.reason ?? "rejected" }
      : { kind: "drop" };
  const group = entry.meta.undoOf ?? entry.meta.redoOf;
  if (group !== undefined)
    client.history.setPending(
      group,
      undefined,
      receipt.outcome === "rejected" ? (receipt.reason ?? "rejected") : undefined,
    );
  client.commitStep(exclude(client.state, new Map([[requestKey(entry.id), how]])), "reconcile", [
    `${receipt.outcome} ${requestKey(entry.id)}`,
  ]);
}
