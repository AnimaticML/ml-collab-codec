import { expect, test } from "bun:test";
import { ensureFreshBuild, root } from "../support/built.ts";

for (const [example, marker] of [
  ["interview-composition", "INTERVIEW_COMPOSITION_OK"],
  ["tabletop-evolution", "TABLETOP_EVOLUTION_OK"],
]) {
  test(`Built consumer example ${example} satisfies its lifecycle assertions`, () => {
    ensureFreshBuild();
    const result = Bun.spawnSync(["node", `examples/${example}.mjs`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(marker ?? "");
  });
}
