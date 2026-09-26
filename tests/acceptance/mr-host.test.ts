import { describe, expect, test } from "bun:test";
import { Authority, recordOf } from "../../src/core/authority.ts";
import type { Decision } from "../../src/core/authority.ts";
import { restoreAuthority } from "../../src/core/checkpoint.ts";
import { AuthorityHost, StaleOwnerError } from "../../src/core/host.ts";
import type { RequestEnvelope, TransitionEvent } from "../../src/core/protocol.ts";
import { ROOT_ID } from "../../src/core/table.ts";
import { listDoc } from "../support/docs.ts";
import { FakeStore } from "../support/fake-store.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";
import { rejection } from "../support/async.ts";

const SCHEMA = { id: "fixture.list", version: "1.0.0" };
const genesis = () => Authority.create(DOC, EPOCH, listDoc({ count: 0, items: [] }));

/** A request adding `by` to the counter, authored by `replica` against revision `base`. */
function bump(replica: string, seq: number, base: number, by = 1): RequestEnvelope {
  const table = listDoc({ count: 0, items: [] });
  return envelope(
    replica,
    seq,
    base,
    build(table, replica, seq, (b) => b.delta(ROOT_ID, "count", by)),
  );
}

/** A manually released gate for one store step. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const count = (host: AuthorityHost): unknown =>
  host.authority.getTable().get(ROOT_ID)?.props["count"];

async function restored(store: FakeStore): Promise<Authority> {
  const stored = await store.read();
  return restoreAuthority(stored.checkpoint, stored.records, SCHEMA);
}

describe("MR39–MR40 asynchronous hosting", () => {
  test("MR39 Delayed durable append: no publication before durability, serialized, fenced, deduplicated", async () => {
    const store = new FakeStore();
    const host = await AuthorityHost.open(store, SCHEMA, genesis);
    const seen: TransitionEvent[] = [];
    host.subscribe((t) => seen.push(t));
    // Delay the first append; a second submission waits behind it (serialized admission).
    const held = gate();
    let first = true;
    store.hooks = {
      gate: (step) => (step === "append" && first ? ((first = false), held.wait) : undefined),
    };
    const a = host.submit(bump("replica-a", 1, 0), { actor: "a" });
    const b = host.submit(bump("replica-b", 1, 0, 10), { actor: "b" });
    await Promise.resolve();
    expect([host.authority.getRevision(), seen.length]).toEqual([0, 0]);
    held.open();
    const [da, db] = await Promise.all([a, b]);
    expect([da, db].map((d) => d.kind === "decided" && d.transition?.revision)).toEqual([1, 2]);
    expect(seen.map((t) => t.revision)).toEqual([1, 2]);
    expect(count(host)).toBe(11);

    // Stale position: another handler of the same owner commits while our append is delayed.
    const held2 = gate();
    let once = true;
    store.hooks = {
      gate: (step) => (step === "append" && once ? ((once = false), held2.wait) : undefined),
    };
    const c = host.submit(bump("replica-c", 1, 2, 100), { actor: "c" });
    const sibling = await restored(store);
    const siblingRecord = recordOf(sibling.prepare(bump("replica-s", 1, 2, 1000), { actor: "s" }));
    if (siblingRecord === undefined) throw new Error("setup");
    store.hooks = {};
    expect(
      await store.append((await store.read()).position, store.currentOwner(), siblingRecord),
    ).toBe("committed");
    held2.open();
    const dc = await c;
    // The stale candidate was not installed: the host reloaded and re-evaluated at revision 4.
    expect(dc.kind === "decided" && dc.transition?.revision).toBe(4);
    expect(count(host)).toBe(1111);
    // Subscribers observe the sibling's transition picked up by the reload, then our own, in order.
    expect(seen.map((t) => t.revision)).toEqual([1, 2, 3, 4]);

    // I/O failure before the write: nothing is installed; the retry is decided once.
    store.hooks = { fail: (step) => (step === "append" ? "before" : undefined) };
    const d = bump("replica-d", 1, 4, 5);
    expect((await rejection(host.submit(d, { actor: "d" }))).message).toContain("I/O failure");
    expect(host.authority.getRevision()).toBe(4);
    store.hooks = {};
    expect(await host.submit(d, { actor: "d" })).toMatchObject({
      duplicate: false,
      receipt: { outcome: "applied" },
    });
    // Lost acknowledgement after a durable write: the retry finds the stored decision (no reapply).
    store.hooks = { fail: (step) => (step === "append" ? "after" : undefined) };
    const e = bump("replica-e", 1, 5, 7);
    expect((await rejection(host.submit(e, { actor: "e" }))).message).toContain("acknowledgement");
    store.hooks = {};
    const retried: Decision = await host.submit(e, { actor: "e" });
    expect(retried).toMatchObject({ duplicate: true, receipt: { outcome: "applied" } });
    expect(count(host)).toBe(1123);
    expect(count(host)).toBe((await restored(store)).getTable().get(ROOT_ID)?.props["count"]);

    // Fencing: a new owner takes over while an append is delayed; the old host installs nothing.
    const held3 = gate();
    store.hooks = { gate: (step) => (step === "append" ? held3.wait : undefined) };
    const f = host.submit(bump("replica-f", 1, 6, 1), { actor: "f" });
    const successor = AuthorityHost.open(store, SCHEMA, genesis);
    held3.open();
    expect(await rejection(f)).toBeInstanceOf(StaleOwnerError);
    store.hooks = {};
    expect(host.authority.getRevision()).toBe(6);
    expect((await successor).authority.getRevision()).toBe(6);
  });

  test("MR40 Async checkpoint cut, interruption, and ownership", async () => {
    for (const step of ["stage", "publish", "prune"] as const) {
      const store = new FakeStore();
      const host = await AuthorityHost.open(store, SCHEMA, genesis);
      const requests = [bump("replica-a", 1, 0, 1), bump("replica-b", 1, 1, 2)];
      for (const [i, request] of requests.entries()) await host.submit(request, { actor: `u${i}` });
      store.hooks = { fail: (s) => (s === step ? "before" : undefined) };
      expect(await rejection(host.checkpoint(0))).toBeInstanceOf(Error);
      store.hooks = {};
      // Prune never runs before a durable publication; the log still holds every record.
      if (step !== "prune") expect(store.prunedThrough).toBe(0);
      const back = await restored(store);
      expect(back.getTable().get(ROOT_ID)?.props["count"]).toBe(3);
      for (const request of requests) expect(back.hasReceipt(request)).toBe(true);
    }
    // A decision crossing the cut (a sibling handler appends after the cut was taken) survives.
    const store = new FakeStore();
    const host = await AuthorityHost.open(store, SCHEMA, genesis);
    await host.submit(bump("replica-a", 1, 0, 1), { actor: "a" });
    const staged = store.pause("publish");
    const checkpoint = host.checkpoint(0);
    await staged.arrived;
    const sibling = await restored(store);
    const record = recordOf(sibling.prepare(bump("replica-s", 1, 1, 10), { actor: "s" }));
    if (record === undefined) throw new Error("setup");
    await store.append(1, store.currentOwner(), record);
    staged.release();
    await checkpoint;
    expect([store.publishedCut(), store.prunedThrough, store.retainedRecords()]).toEqual([1, 1, 1]);
    expect((await restored(store)).getTable().get(ROOT_ID)?.props["count"]).toBe(11);
    // A stale owner cannot publish its older checkpoint over a newer owner's state.
    const held = store.pause("publish");
    const old = host.checkpoint(0);
    await held.arrived;
    const successor = await AuthorityHost.open(store, SCHEMA, genesis);
    await successor.submit(bump("replica-n", 1, 2, 100), { actor: "n" });
    await successor.checkpoint(0);
    held.release();
    expect(await rejection(old)).toBeInstanceOf(StaleOwnerError);
    expect(store.publishedCut()).toBe(3);
    const final = await restored(store);
    expect(final.getTable().get(ROOT_ID)?.props["count"]).toBe(111);
    expect(final.hasReceipt({ replica: "replica-n", seq: 1 })).toBe(true);
  });
});
