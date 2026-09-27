import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHANGE_KINDS } from "../../src/core/change.ts";
import { ensureFreshBuild, root } from "../support/built.ts";
import { docSnippets, materialize } from "../support/doc-snippets.ts";

const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const guides = readdirSync(resolve(root, "docs")).filter((name) => name.endsWith(".md"));

describe("MR42–MR44 consumer documentation, performance evidence, and delivery", () => {
  test("MR42 Runnable consumer documentation describes the actual API", () => {
    // Every ts block in the README and the guides is a complete program that runs.
    const snippets = docSnippets();
    expect(snippets.length).toBeGreaterThanOrEqual(10);
    const failures: string[] = [];
    for (const snippet of snippets) {
      const result = Bun.spawnSync(["bun", materialize(snippet)], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0)
        failures.push(
          `${snippet.file}#${snippet.index}: ${result.stderr.toString().slice(0, 400)}`,
        );
    }
    expect(failures).toEqual([]);
    // The guides cover the required topics and every primitive kind by name.
    const topics = [
      "installation",
      "schemas",
      "documents",
      "operations",
      "collaboration",
      "hosting",
      "agents",
      "runtime",
      "verification",
    ];
    for (const topic of topics) expect(guides).toContain(`${topic}.md`);
    const operations = read("docs/operations.md");
    for (const kind of CHANGE_KINDS) expect(operations).toContain(`\`${kind}\``);
    // No stale names in consumer-facing docs.
    const consumerText = [read("README.md"), ...guides.map((g) => read(`docs/${g}`))].join("\n");
    for (const stale of [
      "schemaInvariants",
      "minimalSplice",
      "removeArrayItem",
      "rootMode",
      "CheckpointError",
      "sdl.ops/1",
      "exportComponentSchema",
      "registerSchema(schema",
    ])
      expect({ stale, present: consumerText.includes(stale) }).toEqual({ stale, present: false });
    // Every documented command exists.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    for (const [, command] of consumerText.matchAll(/bun run ([a-z:-]+)/g))
      expect({ command, exists: command !== undefined && command in scripts }).toEqual({
        command,
        exists: true,
      });
  }, 120_000);

  test("MR43 Benchmarks run with validation and history on and report repeated-sample statistics", () => {
    const run = Bun.spawnSync(["bun", "scripts/bench.ts"], {
      cwd: root,
      env: { ...process.env, BENCH_QUICK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = run.stdout.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toContain("Schema validation, history, and copy-on-acquisition are on");
    expect(out).toMatch(/median \/ p95/);
    // Every measured admission was actually applied by the schema-backed authority.
    const applied = [...out.matchAll(/\| (\d+)\/(\d+) \|/g)];
    expect(applied.length).toBeGreaterThan(0);
    for (const [, done, total] of applied) expect(done).toBe(total);
    // The recorded full run states its environment and the remaining full scans.
    const report = read("reports/benchmarks.md");
    expect(report).toMatch(/Bun \d+\.\d+\.\d+, .*samples after .* warm-up/);
    expect(report).toContain("Remaining full scans");
  }, 120_000);

  test("MR44 Evidence delivery is complete and consistent", () => {
    // Every remediation family has a row (and the inventory guard requires a named test).
    const acceptance = read("ACCEPTANCE.md");
    for (let i = 1; i <= 44; i += 1) {
      const id = `MR${String(i).padStart(2, "0")}`;
      expect({ id, listed: new RegExp(`^\\| ${id} \\|`, "m").test(acceptance) }).toEqual({
        id,
        listed: true,
      });
    }
    // Generated evidence exists and records no failures or surviving faults.
    const coverage = read("reports/ot-pair-coverage.md");
    expect(coverage).toMatch(/Failures: 0\./);
    expect(coverage).not.toContain("## Failures");
    const mutation = read("reports/mutation-report.md");
    expect(mutation).not.toContain("SURVIVED");
    expect(mutation.match(/^## /gm)?.length).toBeGreaterThanOrEqual(15);
    // Guides linked from the index exist; SPEC records the remediation contracts.
    for (const [, link] of read("docs/README.md").matchAll(/\]\(([a-z-]+\.md)\)/g))
      expect(existsSync(resolve(root, "docs", link ?? ""))).toBe(true);
    expect(read("SPEC.md")).toContain("## 19. Remediation");
    expect(read("README.md")).toContain("docs/installation.md");
    // The historical review probes, ported to the current API and ownership contract, pass
    // against the built package (the original file stays unchanged as evidence).
    ensureFreshBuild();
    const probes = Bun.spawnSync(
      ["node", "tests/fixtures/review-probes-adapted.mjs", "dist/index.js"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(probes.stdout.toString()).toContain("11 passed; 0 failed; 11 probes.");
    expect(probes.exitCode).toBe(0);
  }, 60_000);
});
