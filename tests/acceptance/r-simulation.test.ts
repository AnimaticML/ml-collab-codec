import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { ApplyError } from "../../src/core/staging.ts";
import { liveChain } from "../../src/core/client-queue.ts";
import { Client } from "../../src/core/client.ts";
import { SequenceAllocator } from "../../src/core/identity.ts";
import { canonicalTable, randomCommands, randomTable } from "../support/gen.ts";
import { rng, seedBudget } from "../support/random.ts";
import type { Rng } from "../support/random.ts";
import { DOC, EPOCH, Room } from "../support/room.ts";

const NAMES = ["a", "b", "c"] as const;

/** Client invariant at every step: the published view is confirmed state plus the live pending chain. */
function checkContext(client: Client): string | null {
  let expected: string;
  try {
    expected = canonicalTable(
      applyChanges(client.state.confirmed, liveChain(client.state.pending)),
    );
  } catch (error) {
    if (error instanceof ApplyError)
      return `pending chain does not apply to confirmed state (${error.code})`;
    throw error;
  }
  if (canonicalTable(client.state.visible) !== expected)
    return "visible state is not confirmed + pending";
  if (canonicalTable(client.getSnapshot().table) !== expected)
    return "published snapshot diverges from state";
  return null;
}

/** Restart a member from its locally persisted session (confirmed table, pending bytes, handles). */
function reconnect(room: Room, name: string): void {
  const member = room.member(name);
  const old = member.client;
  member.client = new Client({
    documentId: DOC,
    historyEpoch: EPOCH,
    allocator: SequenceAllocator.ephemeral(old.replica, old.options.allocator.last),
    actor: member.actor,
    table: old.state.confirmed,
    revision: old.state.revision,
    restore: old.exportSession(),
  });
  // A reconnecting replica asks for everything after its confirmed revision; events buffered only
  // in the old process are not assumed to survive.
  room.catchUp(name);
  // ...and retries its in-flight request with the original bytes to recover the retained receipt.
  const inFlight = member.client.resend();
  if (inFlight !== undefined) room.submit(name, inFlight);
}

function step(room: Room, r: Rng): void {
  const name = r.pick(NAMES);
  const member = room.member(name);
  const roll = r.int(100);
  if (roll < 33) member.client.transact((b) => randomCommands(b, r, 1 + r.int(2)));
  else if (roll < 50) room.send(name);
  else if (roll < 75 && member.inbox.length > 0) {
    const [event] = member.inbox.splice(r.int(member.inbox.length), 1); // buffered, out-of-order delivery
    if (event !== undefined) {
      member.client.receive(event);
      if (r.chance(0.2)) member.client.receive(event); // duplicate delivery
    }
  } else if (roll < 81) {
    const retry = member.client.resend();
    if (retry !== undefined) room.submit(name, retry); // transport retry of identical bytes
  } else if (roll < 88) member.client.undo();
  else if (roll < 94) member.client.redo();
  else reconnect(room, name);
}

/** Run one seeded history; return a failure description or null. */
function simulate(seed: number, steps: number): string | null {
  const r = rng(seed);
  const room = new Room(randomTable(r));
  NAMES.forEach((name) => room.join(name, `replica-${name}`));
  for (let i = 0; i < steps; i += 1) {
    step(room, r);
    for (const name of NAMES) {
      const problem = checkContext(room.client(name));
      if (problem !== null) return `${name} at step ${i}: ${problem}`;
    }
  }
  room.settle();
  const truth = canonicalTable(room.authority.getTable());
  for (const name of NAMES) {
    const client = room.client(name);
    if (canonicalTable(client.getSnapshot().table) !== truth) return `${name} did not converge`;
    if (client.state.pending.length > 0) return `${name} kept pending work after settling`;
    if (client.state.revision !== room.authority.getRevision()) return `${name} is behind`;
  }
  return null;
}

/** Shrink a failing seed to the shortest failing prefix of steps (reproducible counterexample). */
function shrink(seed: number, steps: number): number {
  for (let n = 1; n < steps; n += 1) if (simulate(seed, n) !== null) return n;
  return steps;
}

/**
 * Minimized counterexamples found by this generator and fixed; kept as fixed regressions:
 * - seed 21 / 34 steps: a transition buffered only in a crashed process was never re-requested;
 *   reconnect now catches up from the confirmed revision.
 * - seed 241 / 29 steps: a rejection receipt buffered only in a crashed process was lost; reconnect
 *   now retries the in-flight request with its original bytes to recover the retained receipt.
 * - seed 1187 / 81 steps (120-step budget): a pending move and an incoming move formed a cycle
 *   hidden by a later pending move; concurrent moves now integrate via private recovery.
 */
const REGRESSIONS: readonly [number, number][] = [
  [21, 34],
  [241, 29],
  [1187, 81],
];

describe("R30 generated multi-client histories", () => {
  test("R30 Minimized counterexamples stay fixed", () => {
    for (const [seed, steps] of REGRESSIONS)
      expect({ seed, failure: simulate(seed, steps) }).toEqual({ seed, failure: null });
  });

  test("R30 Generated multi-client histories converge under the fixed authority decisions", () => {
    const steps = Number(process.env["PROPERTY_STEPS"] ?? "40");
    for (const seed of seedBudget(150)) {
      const failure = simulate(seed, steps);
      if (failure !== null) {
        const minimal = shrink(seed, steps);
        throw new Error(
          `seed ${seed} fails (minimal ${minimal} steps): ${simulate(seed, minimal) ?? failure}`,
        );
      }
    }
    // The generator really exercises acceptance, rejection, undo, and reconnect.
    const r = rng(7);
    const room = new Room(randomTable(r));
    NAMES.forEach((name) => room.join(name, `replica-${name}`));
    for (let i = 0; i < 200; i += 1) step(room, r);
    room.settle();
    const outcomes = room.decisions.map((d) => (d.kind === "decided" ? d.receipt.outcome : d.kind));
    expect(outcomes.filter((o) => o === "applied").length).toBeGreaterThan(10);
    expect(room.authority.transitionsSince(0)?.some((t) => t.meta.undoOf !== undefined)).toBe(true);
  });
});
