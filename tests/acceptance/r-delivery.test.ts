import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureFreshBuild, root } from "../support/built.ts";

const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

describe("R34 public API delivery and regression scope", () => {
  test("R34 Public API delivery and unchanged regression scope", () => {
    ensureFreshBuild();
    // Built ESM package: indexed arrays, grouped typing/drag, undo/redo after remote work,
    // anchor/proposal rebase, counted batching, runtime adapters, and the restricted-region game.
    expect(
      execFileSync("node", [resolve(root, "tests/fixtures/consumer-check.mjs")], {
        encoding: "utf8",
      }).trim(),
    ).toBe("CONSUMER_CHECK_OK");
    const consumer = read("tests/fixtures/consumer-check.mjs");
    for (const workflow of [
      "arrayDelete",
      "beginGroup",
      "undo()",
      "redo()",
      "rebaseProposal",
      "mapAnchor",
      "subscribeCommits",
      "RestrictedAuthority",
      "ClassProjection",
    ])
      expect(consumer).toContain(workflow);
    // Old optional-undo exemptions cannot contradict the collaborative-undo tests.
    for (const doc of ["SPEC.md", "ACCEPTANCE.md", "AGENTS.md", "README.md"]) {
      const text = read(doc);
      expect({
        doc,
        stale: /selective (collaborative )?undo (may be|is) explicitly unsupported/i.test(text),
      }).toEqual({ doc, stale: false });
      expect({ doc, stale: text.includes("Unsupported selective undo reports that fact") }).toEqual(
        { doc, stale: false },
      );
    }
    // The gates and the separate larger property budget are wired into package scripts.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts["check"]).toContain("acceptance:check");
    expect(scripts["check"]).toContain("typecheck:core");
    expect(scripts["check"]).toContain("build");
    expect(scripts["test:property"]).toContain("PROPERTY_BUDGET");
    // Unchanged scope: no editor adapters or encryption dependencies. The only runtime
    // dependency is the portable standard JSON Schema validator (remediation §4.1), pinned exactly.
    const manifest = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({ "@cfworker/json-schema": "4.1.1" });
  });
});
