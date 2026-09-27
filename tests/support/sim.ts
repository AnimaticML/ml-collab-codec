import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { exportCheckpoint, restoreAuthority } from "../../src/core/checkpoint.ts";
import { liveChain } from "../../src/core/client-queue.ts";
import type { Client } from "../../src/core/client.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import type { CandidateValidator } from "../../src/core/invariants.ts";
import { captureBootstrap, joinClient } from "../../src/core/join.ts";
import type { ServerEvent } from "../../src/core/protocol.ts";
import { ApplyError } from "../../src/core/staging.ts";
import type { Table } from "../../src/core/table.ts";
import { ROOT_ID } from "../../src/core/table.ts";
import { canonicalTable, randomCommands, randomTable } from "./gen.ts";
import { dense } from "./ot/generated.ts";
import { rng } from "./random.ts";
import type { Rng } from "./random.ts";

const SIM_SCHEMA = { id: "fixture.sim", version: "1" };
const DOC = "doc-sim";
const EPOCH = "epoch-sim";

/**
 * Realistic final-candidate invariants: the title is required and the root
 * list keeps at least one element (a minItems constraint), so generated
 * histories meet genuine rejections, not only transform conflicts.
 */
const SIM_VALIDATORS: readonly CandidateValidator[] = [
  (candidate) =>
    candidate.get(ROOT_ID)?.props["title"] === undefined ? "title is required" : null,
  (candidate) => {
    const items = candidate.get(ROOT_ID)?.props["items"];
    return Array.isArray(items) && items.length === 0 ? "items needs at least one element" : null;
  },
];

interface Member {
  readonly name: string;
  client: Client;
  inbox: ServerEvent[];
}

/** Counters of what a history actually exercised (checked so generators cannot silently narrow). */
export interface SimStats {
  applied: number;
  rejected: number;
  resyncs: number;
  checkpoints: number;
  joins: number;
  restored: number;
  unavailable: number;
  undo: number;
}

/**
 * An authoritative server with several clients over a simulated network:
 * explicit submission, per-client queues with reordering and duplication,
 * schema-like validators, checkpoint restarts that prune history, fresh
 * mid-run joins, and restarts from persisted sessions through `joinClient`.
 */
class Sim {
  authority: Authority;
  readonly members = new Map<string, Member>();
  readonly stats: SimStats = {
    applied: 0,
    rejected: 0,
    resyncs: 0,
    checkpoints: 0,
    joins: 0,
    restored: 0,
    unavailable: 0,
    undo: 0,
  };

  constructor(table: Table, names: readonly string[]) {
    this.authority = Authority.create(DOC, EPOCH, table, { validators: SIM_VALIDATORS });
    for (const name of names) this.join(name);
  }

  join(name: string): void {
    const client = joinClient({
      bootstrap: captureBootstrap(this.authority, SIM_SCHEMA),
      schema: SIM_SCHEMA,
      allocator: SequenceAllocator.ephemeral(`replica-${name}`),
      actor: name,
    });
    this.members.set(name, { name, client, inbox: [] });
  }

  member(name: string): Member {
    const member = this.members.get(name);
    if (member === undefined) throw new Error(`no member ${name}`);
    return member;
  }

  submit(name: string, envelope: unknown): void {
    const author = this.member(name);
    const decision: Decision = this.authority.submit(envelope, { actor: name });
    if (decision.kind === "resync") {
      // Explicit recovery: the base is past the retained horizon; nothing is guessed.
      this.stats.resyncs += 1;
      author.client.resync(
        this.authority.getTable(),
        this.authority.getRevision(),
        decision.reason,
      );
      author.inbox = [];
      return;
    }
    if (decision.receipt.outcome === "applied" && !decision.duplicate) this.stats.applied += 1;
    if (decision.receipt.outcome === "rejected" && !decision.duplicate) this.stats.rejected += 1;
    if (decision.transition !== undefined && !decision.duplicate)
      for (const member of this.members.values()) member.inbox.push(decision.transition);
    author.inbox.push(decision.receipt);
  }

  send(name: string): void {
    const envelope = this.member(name).client.nextRequest();
    if (envelope !== undefined) this.submit(name, envelope);
  }

  /** Restart the authority from a checkpoint retaining `retain` transitions (the rest are pruned). */
  checkpoint(retain: number): void {
    const bundle: unknown = JSON.parse(
      JSON.stringify(exportCheckpoint(this.authority, SIM_SCHEMA, retain)),
    );
    this.authority = restoreAuthority(bundle, [], SIM_SCHEMA, { validators: SIM_VALIDATORS });
    this.stats.checkpoints += 1;
  }

  /** Restart a member from its persisted session: snapshot + retained tail, or explicit unavailability. */
  restart(name: string): void {
    const member = this.member(name);
    const old = member.client;
    const session = old.exportSession();
    const transitions = this.authority.transitionsSince(session.revision);
    member.client = joinClient({
      bootstrap: captureBootstrap(this.authority, SIM_SCHEMA),
      schema: SIM_SCHEMA,
      ...(transitions === undefined ? {} : { transitions }),
      restore: session,
      allocator: SequenceAllocator.ephemeral(old.replica, old.options.allocator.last),
      actor: name,
    });
    member.inbox = [];
    const status = member.client.getStatus().history.status;
    if (status === "restored") this.stats.restored += 1;
    if (status === "unavailable") this.stats.unavailable += 1;
    const inFlight = member.client.resend();
    if (inFlight !== undefined) this.submit(name, inFlight);
  }

  step(r: Rng, names: string[]): void {
    const name = r.pick(names);
    const member = this.member(name);
    const roll = r.int(100);
    if (roll < 28) member.client.transact((b) => randomCommands(b, r, 1 + r.int(2)));
    else if (roll < 42) this.send(name);
    else if (roll < 64 && member.inbox.length > 0) {
      const [event] = member.inbox.splice(r.int(member.inbox.length), 1);
      if (event !== undefined) {
        member.client.receive(event);
        if (r.chance(0.2)) member.client.receive(event);
      }
    } else if (roll < 68) {
      const retry = member.client.resend();
      if (retry !== undefined) this.submit(name, retry);
    } else if (roll < 80) {
      if (member.client.undo().status === "requested") this.stats.undo += 1;
    } else if (roll < 87) member.client.redo();
    else if (roll < 92) this.restart(name);
    else if (roll < 96) this.checkpoint(r.int(4));
    else if (names.length < 5) {
      const fresh = `n${names.length}`;
      this.join(fresh);
      this.stats.joins += 1;
      names.push(fresh);
    }
  }

  /** Send (or retry) every member's next request and deliver everything, until quiescent. */
  settle(): void {
    for (let round = 0; round < 1000; round += 1) {
      let moved = false;
      for (const member of this.members.values()) {
        const request =
          member.client.getStatus().inFlight === undefined
            ? member.client.nextRequest()
            : member.client.resend();
        if (request !== undefined) {
          this.submit(member.name, request);
          moved = true;
        }
      }
      for (const member of this.members.values()) moved = this.catchUp(member) || moved;
      if (!moved) return;
    }
    throw new Error("simulation did not settle");
  }

  /** Deliver queued events plus any retained transitions the member lacks; past the horizon, resync. */
  private catchUp(member: Member): boolean {
    let moved = false;
    if (member.inbox.length > 0) {
      member.client.receive(member.inbox.splice(0));
      moved = true;
    }
    const missing = this.authority.transitionsSince(member.client.state.revision);
    if (missing === undefined) {
      this.stats.resyncs += 1;
      member.client.resync(this.authority.getTable(), this.authority.getRevision(), "past horizon");
      return true;
    }
    if (missing.length > 0) member.client.receive(missing);
    return moved || missing.length > 0;
  }
}

/** Published view = confirmed state + live pending chain, and the snapshot matches it. */
function checkContext(client: Client): string | null {
  let expected: string;
  try {
    expected = canonicalTable(
      applyChanges(client.state.confirmed, liveChain(client.state.pending)),
    );
  } catch (error) {
    if (error instanceof ApplyError) return `pending chain does not apply (${error.code})`;
    throw error;
  }
  if (canonicalTable(client.state.visible) !== expected)
    return "visible is not confirmed + pending";
  if (canonicalTable(client.getSnapshot().table) !== expected) return "snapshot diverges";
  return null;
}

/** Run one seeded history; return a failure description or null (plus what it exercised). */
export function simulateHistory(seed: number, steps: number, stats?: SimStats[]): string | null {
  const r = rng(seed);
  const names = ["a", "b", "c"];
  const sim = new Sim(r.chance(0.4) ? dense() : randomTable(r), names);
  for (let i = 0; i < steps; i += 1) {
    sim.step(r, names);
    for (const name of names) {
      const problem = checkContext(sim.member(name).client);
      if (problem !== null) return `${name} at step ${i}: ${problem}`;
    }
  }
  sim.settle();
  stats?.push(sim.stats);
  const truth = canonicalTable(sim.authority.getTable());
  for (const validator of SIM_VALIDATORS) {
    const verdict = validator(sim.authority.getTable(), [], sim.authority.getTable());
    if (verdict !== null) return `accepted state violates an invariant: ${verdict}`;
  }
  for (const name of names) {
    const client = sim.member(name).client;
    if (canonicalTable(client.getSnapshot().table) !== truth) return `${name} did not converge`;
    if (client.state.pending.length > 0) return `${name} kept pending work after settling`;
    if (client.state.revision !== sim.authority.getRevision()) return `${name} is behind`;
  }
  return null;
}

export function shrinkHistory(seed: number, steps: number): number {
  for (let n = 1; n < steps; n += 1) if (simulateHistory(seed, n) !== null) return n;
  return steps;
}
