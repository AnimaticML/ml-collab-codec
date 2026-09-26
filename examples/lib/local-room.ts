/**
 * A tiny in-process loopback between one authority and several clients, for
 * headless examples. A real deployment replaces this with its own transport,
 * authentication, and persistence adapters.
 */
import { Authority, Client, SequenceAllocator } from "../../src/index.ts";
import type { AuthorityOptions, Table } from "../../src/index.ts";

export class LocalRoom {
  readonly authority: Authority;
  private readonly clients = new Map<string, Client>();

  constructor(table: Table, options: AuthorityOptions = {}) {
    this.authority = Authority.create("example-doc", "epoch-1", table, options);
  }

  join(actor: string): Client {
    const client = new Client({
      documentId: "example-doc",
      historyEpoch: "epoch-1",
      allocator: SequenceAllocator.ephemeral(`replica-${actor}`),
      actor,
      table: this.authority.getTable(),
      revision: this.authority.getRevision(),
    });
    this.clients.set(actor, client);
    return client;
  }

  /** Send every client's queued requests and deliver all resulting events, until quiet. */
  settle(): void {
    for (let moved = true; moved;) {
      moved = false;
      for (const [actor, client] of this.clients) {
        const request = client.nextRequest();
        if (request === undefined) continue;
        moved = true;
        const decision = this.authority.submit(request, { actor });
        if (decision.kind !== "decided") throw new Error(`resync required: ${decision.reason}`);
        if (decision.transition !== undefined)
          for (const peer of this.clients.values()) peer.receive(decision.transition);
        client.receive(decision.receipt);
      }
    }
  }
}
