import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { root } from "../support/built.ts";

const run = (cwd: string, command: string, args: string[]): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** `major.minor.patch` ≥ the lower bound of a `>=x.y[.z]` range. */
function satisfies(version: string, range: string): boolean {
  const want = range.replace(">=", "").split(".").map(Number);
  const have = version.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const [h, w] = [have[i] ?? 0, want[i] ?? 0];
    if (h !== w) return h > w;
  }
  return true;
}

describe("MR41 clean pinned-Git consumer", () => {
  test("MR41 A fixed commit builds from a clean checkout and serves a separate consumer", () => {
    const work = mkdtempSync(join(tmpdir(), "ml-collab-git-"));
    try {
      // The documented recipe: clone a pinned commit, install from the lockfile, build.
      const sha = run(root, "git", ["rev-parse", "HEAD"]).trim();
      const lib = join(work, "ml-collab-codec");
      run(work, "git", ["clone", "--quiet", "--no-local", root, lib]);
      run(lib, "git", ["checkout", "--quiet", sha]);
      expect(existsSync(join(lib, "dist"))).toBe(false);
      expect(existsSync(join(lib, "node_modules"))).toBe(false);
      run(lib, "bun", ["install", "--frozen-lockfile"]);
      run(lib, "bun", ["run", "build"]);
      const manifest = JSON.parse(readFileSync(join(lib, "package.json"), "utf8")) as {
        exports: { ".": { import: string; types: string } };
        engines: { node: string; bun: string };
      };
      for (const target of Object.values(manifest.exports["."]))
        expect({ target, exists: existsSync(join(lib, target)) }).toEqual({ target, exists: true });
      // Version claims match the runtimes this suite actually executes.
      expect(satisfies(run(root, "node", ["--version"]).trim(), manifest.engines.node)).toBe(true);
      expect(satisfies(Bun.version, manifest.engines.bun)).toBe(true);
      // A separate consumer depends on the checkout by path, never on private sources.
      const consumer = join(work, "consumer");
      cpSync(resolve(root, "tests/fixtures/consumer-types"), consumer, { recursive: true });
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "consumer",
          private: true,
          type: "module",
          dependencies: { "ml-collab-codec": `file:${lib}` },
        }),
      );
      run(consumer, "bun", ["install"]);
      const script = readFileSync(
        resolve(root, "tests/fixtures/consumer-check.mjs"),
        "utf8",
      ).replace('"../../dist/index.js"', '"ml-collab-codec"');
      writeFileSync(join(consumer, "check.mjs"), script);
      expect(run(consumer, "node", ["check.mjs"]).trim()).toBe("CONSUMER_CHECK_OK");
      expect(run(consumer, "bun", ["check.mjs"]).trim()).toBe("CONSUMER_CHECK_OK");
      // The type consumer resolves the package's declared `types` export (no path mapping).
      const tsconfig = JSON.parse(readFileSync(join(consumer, "tsconfig.json"), "utf8")) as {
        compilerOptions: Record<string, unknown>;
      };
      delete tsconfig.compilerOptions["paths"];
      writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify(tsconfig));
      run(consumer, resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
