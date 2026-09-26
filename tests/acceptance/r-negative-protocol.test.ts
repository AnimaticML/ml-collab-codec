import { describe, expect, test } from "bun:test";
import { applyChanges } from "../../src/core/apply.ts";
import { Authority } from "../../src/core/authority.ts";
import type { AuthorityState } from "../../src/core/authority.ts";
import type { Change } from "../../src/core/change.ts";
import { invertChanges } from "../../src/core/change.ts";
import { reconcile } from "../../src/core/client-queue.ts";
import type { PendingEntry } from "../../src/core/client-queue.ts";
import { classify } from "../../src/core/grouping.ts";
import { Ledger } from "../../src/core/ledger.ts";
import type { ReceiptEvent } from "../../src/core/protocol.ts";
import { ProtocolError } from "../../src/core/protocol.ts";
import { schemaValidator } from "../../src/core/invariants.ts";
import { ROOT_ID, textOf } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { isConflict, rebase } from "../../src/core/transform.ts";
import type { TransformConflict } from "../../src/core/transform.ts";
import { items, listDoc, listSchema, textDoc } from "../support/docs.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";

type Rebase = (
  changes: readonly Change[],
  accepted: readonly Change[],
  after: Table,
) => readonly Change[] | TransformConflict;
const realRebase: Rebase = (changes, accepted) => rebase(changes, accepted);

/** Oracle: concurrent requests from one base, rebased in admission order, give `expected`. */
function converges(
  base: Table,
  requests: readonly Change[][],
  engine: Rebase,
  read: (t: Table) => unknown,
  expected: unknown,
): boolean {
  let state = base;
  const accepted: Change[][] = [];
  for (const request of requests) {
    let form: readonly Change[] = request;
    for (const done of accepted) {
      const next = engine(form, done, state);
      if (isConflict(next)) return false;
      form = next;
    }
    try {
      state = applyChanges(state, form);
    } catch {
      return false;
    }
    accepted.push([...form]);
  }
  return JSON.stringify(read(state)) === JSON.stringify(expected);
}

const duplicateRemoval = () => {
  const base = listDoc({ items: ["a", "a", "b"] });
  const del = (replica: string) =>
    build(base, replica, 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0));
  return (engine: Rebase) =>
    converges(base, [del("replica-a"), del("replica-b")], engine, items, ["a", "b"]);
};

const deletePreservesInsert = () => {
  const base = textDoc("abcd");
  const ins = build(base, "replica-b", 1, (b) => b.textInsert("t", 2, "X"));
  const del = build(base, "replica-a", 1, (b) => b.textDelete("t", 1, 2));
  return (engine: Rebase) => converges(base, [ins, del], engine, (t) => textOf(t.get("t")), "aXd");
};

describe("R33 negative controls: operation and protocol faults are detected", () => {
  test("R33 Negative controls detect wrong-but-green protocol implementations", () => {
    // Value-search removal of the next duplicate.
    const valueSearch: Rebase = (changes, accepted, after) => {
      const rebased = rebase(changes, accepted);
      if (isConflict(rebased)) return rebased;
      const current = after.get(ROOT_ID)?.props["items"] as unknown[];
      const original = changes[0];
      if (original?.kind !== "arrayDelete") return rebased;
      const index = current.findIndex(
        (v) => JSON.stringify(v) === JSON.stringify(original.values[0]),
      );
      return index < 0 ? [] : [{ ...original, index }];
    };
    expect(duplicateRemoval()(realRebase)).toBe(true);
    expect(duplicateRemoval()(valueSearch)).toBe(false);

    // Endpoint-only deletion that swallows the concurrent insertion.
    const endpointOnly: Rebase = (changes, accepted) => {
      const rebased = rebase(changes, accepted);
      if (isConflict(rebased) || rebased.length < 2) return rebased;
      const pieces = rebased.filter(
        (c): c is Extract<Change, { kind: "textDelete" }> => c.kind === "textDelete",
      );
      const start = Math.min(...pieces.map((c) => c.offset));
      return [{ ...(pieces[0] as Change & { kind: "textDelete" }), offset: start, text: "bXc" }];
    };
    expect(deletePreservesInsert()(realRebase)).toBe(true);
    expect(deletePreservesInsert()(endpointOnly)).toBe(false);

    // Reject-all-stale: refuses every concurrent pair.
    const rejectAll: Rebase = () => ({ conflict: "concurrentWrite", detail: "stale" });
    expect(deletePreservesInsert()(rejectAll)).toBe(false);

    // Dependent pending entries treated as if each were authored at the shared base.
    const base = textDoc("ab");
    const w1 = build(base, "replica-l", 1, (b) => b.textInsert("t", 1, "X"));
    const w2 = build(applyChanges(base, w1), "replica-l", 2, (b) => b.textInsert("t", 2, "Z"));
    const y = build(base, "replica-0", 1, (b) => b.textInsert("t", 2, "Y"));
    const entry = (id: number, working: Change[]): PendingEntry => ({
      id: { replica: "replica-l", seq: id },
      meta: {},
      working,
      shape: classify(working),
      state: "unsent",
    });
    const pending = [entry(1, w1), entry(2, w2)];
    const confirmed = applyChanges(base, y);
    const real = reconcile(pending, y).pending.flatMap((e) => [...e.working]);
    const sharedBase = pending.flatMap((e) => {
      const r = rebase(e.working, y);
      return isConflict(r) ? [] : [...r];
    });
    expect(textOf(applyChanges(confirmed, real).get("t"))).toBe("aXZbY");
    expect(textOf(applyChanges(confirmed, sharedBase).get("t"))).not.toBe("aXZbY");

    // Stale inverse payload after rebase: offsets move but the removed text is copied unchanged.
    const del = build(textDoc("abcd"), "replica-a", 1, (b) => b.textDelete("t", 1, 2));
    const ins = build(textDoc("abcd"), "replica-b", 1, (b) => b.textInsert("t", 2, "X"));
    const branch = applyChanges(textDoc("abcd"), ins);
    const good = rebase(del, ins);
    if (isConflict(good)) throw new Error("compatible");
    const stale = good
      .map((c) => (c.kind === "textDelete" ? { ...c, text: c === good[0] ? "bc" : "" } : c))
      .filter((c) => c.kind !== "textDelete" || c.text !== "");
    const restores = (records: readonly Change[]): boolean => {
      try {
        return (
          textOf(applyChanges(applyChanges(branch, records), invertChanges(records)).get("t")) ===
          "abXcd"
        );
      } catch {
        return false;
      }
    };
    expect(restores(good)).toBe(true);
    expect(restores(stale)).toBe(false);
  });

  test("R33 Negative controls detect wrong-but-green authority accounting", () => {
    const base = listDoc({ items: ["a", "b"], count: 10 });
    const deltaRequest = envelope(
      "replica-a",
      1,
      0,
      build(base, "replica-a", 1, (b) => b.delta(ROOT_ID, "count", 5)),
    );
    // Retry that re-executes (a fresh identity per transport attempt) instead of deduplicating.
    const counted = (mintNewId: boolean): unknown => {
      const auth = Authority.create(DOC, EPOCH, base);
      for (let attempt = 0; attempt < 3; attempt += 1)
        auth.submit(mintNewId ? { ...deltaRequest, seq: 1 + attempt } : deltaRequest, {
          actor: "a",
        });
      return auth.getTable().get(ROOT_ID)?.props["count"];
    };
    expect(counted(false)).toBe(15);
    expect(counted(true)).not.toBe(15);

    // A rejected request re-executed after the situation relaxed (rejection receipts not retained).
    const validators = [schemaValidator(listSchema)];
    const removeB = envelope(
      "replica-c",
      1,
      0,
      build(base, "replica-c", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 1)),
    );
    const relaxedRetry = (forgetRejections: boolean): string => {
      const auth = Authority.create(DOC, EPOCH, base, { validators });
      auth.submit(
        envelope(
          "replica-a",
          1,
          0,
          build(base, "replica-a", 1, (b) => b.arrayDelete(ROOT_ID, ["items"], 0)),
        ),
        { actor: "a" },
      );
      auth.submit(removeB, { actor: "c" });
      auth.submit(
        envelope(
          "replica-z",
          1,
          1,
          build(auth.getTable(), "replica-z", 1, (b) =>
            b.arrayInsert(ROOT_ID, ["items"], 0, ["n"]),
          ),
        ),
        { actor: "z" },
      );
      const state: AuthorityState = auth.exportState();
      const ledger = forgetRejections
        ? {
            ...state.ledger,
            receipts: state.ledger.receipts.filter((r) => r.receipt.outcome !== "rejected"),
            replicas: [],
          }
        : state.ledger;
      const next = new Authority({ ...state, ledger }, { validators });
      const retry = next.submit(removeB, { actor: "c" });
      return retry.kind === "decided" ? retry.receipt.outcome : retry.kind;
    };
    expect(relaxedRetry(false)).toBe("rejected");
    expect(relaxedRetry(true)).toBe("applied");

    // Highest-counter-only accounting fabricates a receipt for a hole below the highest sequence.
    class HighestCounterLedger extends Ledger {
      override lookup(id: { replica: string; seq: number }) {
        const found = super.lookup(id);
        if (found.kind !== "unavailable") return found;
        const receipt: ReceiptEvent = {
          type: "receipt",
          documentId: DOC,
          historyEpoch: EPOCH,
          request: id,
          outcome: "applied",
          evaluatedRevision: 0,
          committedRevision: 1,
        };
        return { kind: "found" as const, record: { fingerprint: "", receipt } };
      }
    }
    for (const [ledger, expected] of [
      [new Ledger(), "unavailable"],
      [new HighestCounterLedger(), "found"],
    ] as const) {
      ledger.record(
        "a",
        "x",
        {
          type: "receipt",
          documentId: DOC,
          historyEpoch: EPOCH,
          request: { replica: "replica-a", seq: 5 },
          outcome: "applied",
          evaluatedRevision: 0,
          committedRevision: 1,
        },
        undefined,
      );
      expect(ledger.lookup({ replica: "replica-a", seq: 3 }).kind).toBe(expected);
    }

    // Committed order conflated with authored dependencies (a stale base treated as current).
    const text = textDoc("ab");
    const first = envelope(
      "replica-z",
      1,
      0,
      build(text, "replica-z", 1, (b) => b.textInsert("t", 1, "X")),
    );
    const second = envelope(
      "replica-a",
      1,
      0,
      build(text, "replica-a", 1, (b) => b.textInsert("t", 2, "Y")),
    );
    const causal = (conflate: boolean): string => {
      const auth = Authority.create(DOC, EPOCH, text);
      auth.submit(first, { actor: "z" });
      auth.submit(conflate ? { ...second, baseRevision: auth.getRevision() } : second, {
        actor: "a",
      });
      return textOf(auth.getTable().get("t"));
    };
    expect(causal(false)).toBe("aXbY");
    expect(causal(true)).not.toBe("aXbY");

    // Arrival-order ties (origins re-minted from admission order) break order independence.
    const tie = (remint: boolean): string[] =>
      [
        ["replica-a", "replica-b"],
        ["replica-b", "replica-a"],
      ].map((order) => {
        const auth = Authority.create(DOC, EPOCH, text);
        order.forEach((replica, arrival) => {
          const changes = build(text, replica, 1, (b) => b.textInsert("t", 1, replica.slice(-1)));
          const minted = remint
            ? changes.map((c) => ({
                ...c,
                origin: { replica: "arrival", seq: arrival + 1, ordinal: 0 },
              }))
            : changes;
          auth.submit(envelope(replica, 1, 0, minted), { actor: replica });
        });
        return textOf(auth.getTable().get("t"));
      });
    expect(new Set(tie(false)).size).toBe(1);
    expect(new Set(tie(true)).size).toBe(2);

    // Re-minted origin priority after rebase/packing (a new wrapper identity replaces the source origin).
    const reminted = (remint: boolean): string => {
      const auth = Authority.create(DOC, EPOCH, text);
      auth.submit(
        envelope(
          "replica-m",
          1,
          0,
          build(text, "replica-m", 1, (b) => b.textInsert("t", 1, "Y")),
        ),
        { actor: "m" },
      );
      const packed = build(text, "replica-z", 1, (b) => b.textInsert("t", 1, "X"));
      const wrapped = remint
        ? packed.map((c) => ({ ...c, origin: { replica: "inc-0", seq: 1, ordinal: 0 } }))
        : packed;
      auth.submit(envelope("replica-z", 1, 0, wrapped), { actor: "z" });
      return textOf(auth.getTable().get("t"));
    };
    expect(reminted(false)).toBe("aYXb");
    expect(reminted(true)).not.toBe("aYXb");

    // Cross-document/epoch identity collision must fail before mutation.
    const other = Authority.create("doc-2", EPOCH, base);
    expect(() => other.submit(deltaRequest, { actor: "a" })).toThrow(ProtocolError);
    const collide = Authority.create(DOC, EPOCH, base);
    expect(() => collide.submit({ ...deltaRequest, documentId: "doc-2" }, { actor: "a" })).toThrow(
      ProtocolError,
    );
    expect(other.getRevision() + collide.getRevision()).toBe(0);
  });
});
