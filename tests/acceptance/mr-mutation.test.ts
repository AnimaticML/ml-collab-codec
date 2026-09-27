import { describe, expect, test } from "bun:test";
import { root } from "../support/built.ts";
import { FAULTS } from "../mutation/faults.ts";

/** Run the killer suites against the implementation with one fault applied at load time. */
function runWithFault(id: string, files: readonly string[]): { code: number; out: string } {
  const result = Bun.spawnSync(
    ["bun", "test", "--preload", "./tests/mutation/preload.ts", ...files],
    { cwd: root, env: { ...process.env, MUTATION: id }, stdout: "pipe", stderr: "pipe" },
  );
  return { code: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

describe("MR38 negative controls against real implementation paths", () => {
  test("MR38 Every controlled fault is killed by a semantic assertion", () => {
    expect(FAULTS.length).toBeGreaterThanOrEqual(15);
    const survivors: string[] = [];
    for (const fault of FAULTS) {
      const { code, out } = runWithFault(fault.id, fault.killers);
      // The fault really loaded, and the run failed on assertions (not on a load or syntax error).
      const applied = out.includes(`MUTATION APPLIED ${fault.id}`);
      const assertionFailure = /^\(fail\) /m.test(out) && !out.includes("Unhandled error");
      if (!applied || code === 0 || !assertionFailure)
        survivors.push(
          `${fault.id}: applied=${applied} exit=${code} assertionFailure=${assertionFailure}`,
        );
    }
    expect(survivors).toEqual([]);
  }, 300_000);
});
