import { expect, test } from "bun:test";
import { ensureFreshBuild, root } from "../support/built.ts";

function run(scenario: string): void {
  ensureFreshBuild();
  const result = Bun.spawnSync(["node", "examples/native-templates.mjs", scenario], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("NATIVE_TEMPLATES_OK");
}

test("C21 Native text-bearing templates persist after incremental filling", () =>
  run("participant"));
test("C22 Inline inference is order independent and rename is undoable", () => run("participant"));
test("C23 Keyed cards preserve identity, fragments and reference ownership", () => run("cards"));
test("C24 Semantic planning is atomic, guarded, authorized and reversible", () => run("schedule"));
test("C25 Incremental evaluation matches a full rebuild", () => run("incremental"));

test("C22 A rename rejects stale occurrence ownership", () => run("renameOwnership"));
test("C23 Inactive object contracts do not require nested inputs", () =>
  run("conditionalRequirements"));
test("C23 Empty repeats validate scope before evaluating items", () => run("emptyRepeatScope"));
