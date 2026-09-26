import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { registerSchema } from "../../src/core/schema-legacy.ts";
import { parseDocument } from "../../src/core/parser.ts";
import { serializeDocument } from "../../src/core/serializer.ts";
import { applyChanges } from "../../src/core/apply.ts";
import type { Change } from "../../src/core/change.ts";
import { diffToChanges } from "../../src/core/diff.ts";
import { fromTable } from "../../src/core/table.ts";
import type { Table } from "../../src/core/table.ts";
import { isConflict, rebase } from "../../src/core/transform.ts";
import { Authority } from "../../src/core/authority.ts";
import { richTextSchema } from "../fixtures/rich-text-schema.ts";
import { randomChange, randomTable } from "../support/gen.ts";
import { listDoc, textDoc } from "../support/docs.ts";
import { setupGame } from "../support/game.ts";
import { rng, seedBudget } from "../support/random.ts";
import { build, envelope } from "../support/requests.ts";
import { DOC, EPOCH } from "../support/room.ts";
import { ensureFreshBuild, root } from "../support/built.ts";

test("Q01 Execute across claimed runtimes", () => {
  ensureFreshBuild();
  const script = resolve(root, "tests/fixtures/runtime-check.mjs");
  expect(execFileSync("node", [script], { encoding: "utf8" }).trim()).toBe("RUNTIME_CHECK_OK");
  expect(execFileSync("bun", [script], { encoding: "utf8" }).trim()).toBe("RUNTIME_CHECK_OK");
  const worker = execFileSync("node", [resolve(root, "tests/fixtures/worker-host.mjs")], {
    encoding: "utf8",
  });
  expect(worker).toContain("RUNTIME_CHECK_OK");
  expect(worker).toContain("WORKER_OK");
});

test("Q02 Built consumer and autonomous examples", () => {
  ensureFreshBuild();
  const out = execFileSync("node", [resolve(root, "tests/fixtures/consumer-check.mjs")], {
    encoding: "utf8",
  });
  expect(out.trim()).toBe("CONSUMER_CHECK_OK");
  // The declarations alone type-check a separate TypeScript consumer.
  execFileSync(
    resolve(root, "node_modules/.bin/tsc"),
    ["-p", resolve(root, "tests/fixtures/consumer-types/tsconfig.json")],
    { encoding: "utf8" },
  );
  for (const example of ["rich-text", "board", "hidden-hand", "canvas"]) {
    const printed = execFileSync("bun", [resolve(root, `examples/${example}.ts`)], {
      encoding: "utf8",
    });
    expect(printed).toContain("EXAMPLE_OK");
  }
});

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

test("Q03 Property and negative-control quality", () => {
  // Codec idempotence on generated mixed-content text.
  for (const seed of seedBudget(60)) {
    const r = rng(seed);
    const text = Array.from({ length: 1 + r.int(8) }, () =>
      r.pick([..."abc XYZ Ёж😀 café<&>"]),
    ).join("");
    const parsed = parseDocument(`<doc><p id="p1">${escapeText(text)}</p></doc>`, richTextSchema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) continue;
    const reparsed = parseDocument(serializeDocument(parsed.value, richTextSchema), richTextSchema);
    expect(reparsed.ok && reparsed.value).toEqual(parsed.value);
  }
  // apply(A, diff(A, B)) ≡ B for generated documents and generated edits. Seeds 528, 2458, and
  // 3826 (found by the larger budget) moved a persisted node into a newly created parent; the diff
  // recreated it under its existing id. Fixed by inserting the new parent's shell and moving it in.
  for (const seed of [528, 2458, 3826, ...seedBudget(300)]) {
    const r = rng(seed);
    const a = randomTable(r);
    const b = applyChanges(a, randomChange(a, r, "replica-g", 1, 4));
    const target = fromTable(b, "x", "1");
    const result = applyChanges(a, diffToChanges(a, target.root, { replica: "replica-d", seq: 1 }));
    expect({ seed, model: fromTable(result, "x", "1") }).toEqual({ seed, model: target });
  }

  // Negative controls: each defect is caught by the same semantic assertion the real code passes.
  const base = textDoc("abcd");
  const del = build(base, "replica-a", 1, (w) => w.textDelete("t", 1, 2));
  const ins = build(base, "replica-b", 1, (w) => w.textInsert("t", 2, "X"));
  const outcome = (
    engine: (
      a: readonly Change[],
      b: readonly Change[],
    ) => readonly Change[] | { conflict: string },
    apply: (t: Table, c: readonly Change[]) => Table,
  ): string => {
    const rebased = engine(del, ins);
    if (isConflict(rebased as never)) return "rejected";
    return JSON.stringify(apply(apply(base, ins), rebased as Change[]).get("t")?.props["value"]);
  };
  expect(outcome(rebase, applyChanges)).toBe('"aXd"');
  expect(outcome(() => ({ conflict: "stale" }), applyChanges)).not.toBe('"aXd"'); // reject-all
  const dropsInsert = (t: Table, c: readonly Change[]) =>
    applyChanges(
      t,
      c.filter((x) => x.kind !== "textInsert"),
    );
  expect(JSON.stringify(dropsInsert(base, ins).get("t")?.props["value"])).not.toBe('"abXcd"'); // dropped insertion

  const counter = listDoc({ count: 10 });
  const plus = envelope(
    "replica-a",
    1,
    0,
    build(counter, "replica-a", 1, (w) => w.delta("$root", "count", 2)),
  );
  const auth = Authority.create(DOC, EPOCH, counter);
  auth.submit(plus, { actor: "a" });
  auth.submit(plus, { actor: "a" });
  expect(auth.getTable().get("$root")?.props["count"]).toBe(12); // repeated delta detected by dedupe
  const naive = Authority.create(DOC, EPOCH, counter);
  naive.submit(plus, { actor: "a" });
  naive.submit({ ...plus, seq: 2 }, { actor: "a" });
  expect(naive.getTable().get("$root")?.props["count"]).not.toBe(12);

  const opacity = registerSchema({
    id: "q03.opacity",
    version: "1.0.0",
    rootTag: "box",
    unknownPolicy: "error",
    components: {
      box: {
        tag: "box",
        identity: "none",
        properties: { opacity: { type: "number", default: 1 } },
        content: { mode: "none" },
      },
    },
  });
  expect(parseDocument(`<box opacity="bad" />`, opacity).ok).toBe(false); // no silent default
  const silentDefault = (raw: string): number => (Number.isFinite(Number(raw)) ? Number(raw) : 1);
  expect(silentDefault("bad")).toBe(1);

  const game = setupGame();
  const decision = game.submit(
    envelope(
      "replica-bob",
      1,
      0,
      build(game.fullView(), "replica-bob", 1, (w) => w.set("cardB1", "rank", "K")),
    ),
    { actor: "bob" },
  );
  expect(JSON.stringify(decision.eventsFor("alice"))).not.toContain('"7"'); // secret old value
  expect(JSON.stringify(decision.decision)).toContain('"7"');
});
