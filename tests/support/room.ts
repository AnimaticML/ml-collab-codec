import { Authority } from "../../src/core/authority.ts";
import type { AuthorityOptions, Decision } from "../../src/core/authority.ts";
import { Client } from "../../src/core/client.ts";
import type { ClientOptions } from "../../src/core/client.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import type { ServerEvent } from "../../src/core/protocol.ts";
import type { Table } from "../../src/core/table.ts";

export const DOC = "doc-1";
export const EPOCH = "epoch-1";

interface Member {
  readonly name: string;
  readonly actor: string;
  client: Client;
  inbox: ServerEvent[];
}

/**
 * A simulated authority and network: requests are submitted explicitly,
 * server events queue per client, and tests choose delivery order,
 * duplication, and delay. Every piece is the real library.
 */
export class Room {
  readonly authority: Authority;
  readonly members = new Map<string, Member>();
  readonly decisions: Decision[] = [];

  constructor(table: Table, options: AuthorityOptions = {}) {
    this.authority = Authority.create(DOC, EPOCH, table, options);
  }

  join(name: string, replica: string, actor = name, extra: Partial<ClientOptions> = {}): Client {
    const client = new Client({
      documentId: DOC,
      historyEpoch: EPOCH,
      allocator: SequenceAllocator.ephemeral(replica),
      actor,
      table: this.authority.getTable(),
      revision: this.authority.getRevision(),
      ...extra,
    });
    this.members.set(name, { name, actor, client, inbox: [] });
    return client;
  }

  member(name: string): Member {
    const member = this.members.get(name);
    if (member === undefined) throw new Error(`no member ${name}`);
    return member;
  }

  client(name: string): Client {
    return this.member(name).client;
  }

  /** Submit an envelope as `name`, broadcasting transitions to everyone and the receipt to the author. */
  submit(name: string, envelope: unknown): Decision {
    const author = this.member(name);
    const decision = this.authority.submit(envelope, { actor: author.actor });
    this.decisions.push(decision);
    if (decision.kind === "decided") {
      if (decision.transition !== undefined && !decision.duplicate)
        for (const member of this.members.values()) member.inbox.push(decision.transition);
      author.inbox.push(decision.receipt);
    }
    return decision;
  }

  /** Send the client's next request, if any. */
  send(name: string): Decision | undefined {
    const envelope = this.client(name).nextRequest();
    return envelope === undefined ? undefined : this.submit(name, envelope);
  }

  /** Deliver queued events (all, or the first `count`) to a member, in queue order. */
  deliver(name: string, count = Infinity): void {
    const member = this.member(name);
    const events = member.inbox.splice(0, count);
    if (events.length > 0) member.client.receive(events);
  }

  /** Reconnect catch-up: queue every accepted transition after the client's confirmed revision. */
  catchUp(name: string): void {
    const member = this.member(name);
    const missing = this.authority.transitionsSince(member.client.state.revision);
    if (missing === undefined) throw new Error("catch-up context is no longer retained");
    member.inbox.push(...missing);
  }

  /** Repeatedly send and deliver for everyone until nothing moves. */
  settle(): void {
    for (let round = 0; round < 1000; round += 1) {
      let moved = false;
      for (const member of this.members.values()) {
        if (this.send(member.name) !== undefined) moved = true;
      }
      for (const member of this.members.values()) {
        if (member.inbox.length > 0) {
          this.deliver(member.name);
          moved = true;
        }
      }
      if (!moved) return;
    }
    throw new Error("room did not settle");
  }
}
