import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAcceptance } from "./lib/acceptance-status.ts";
import type { TestSource } from "./lib/acceptance-status.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function collectTests(directory: string): Promise<TestSource[]> {
  const collected: TestSource[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collected.push(...(await collectTests(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      collected.push({ path, source: await readFile(path, "utf8") });
    }
  }
  return collected;
}

async function main(): Promise<void> {
  const spec = await readFile(resolve(root, "ACCEPTANCE.md"), "utf8");
  const ids = [...spec.matchAll(/^\|\s*((?:MR|[CSIOPVQR])\d{2})\s*\|/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const sources = await collectTests(resolve(root, "tests/acceptance"));
  let hasEntry = false;
  try {
    await access(resolve(root, "src/index.ts"));
    hasEntry = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const problems = inspectAcceptance(ids, sources, hasEntry);
  if (problems.length > 0) {
    console.error(
      "Acceptance incomplete:\n" + problems.map((problem) => `- ${problem}`).join("\n"),
    );
    process.exitCode = 1;
  } else {
    console.log(
      `All ${ids.length} baseline and revision IDs have active tests. Actual test execution must also pass.`,
    );
  }
}

await main();
