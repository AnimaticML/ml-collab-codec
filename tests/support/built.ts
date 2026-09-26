import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));

function newestSource(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** Built-package tests must never exercise a stale dist: rebuild when any source is newer. */
export function ensureFreshBuild(): void {
  const bundle = resolve(root, "dist/index.js");
  const types = resolve(root, "dist/types/index.d.ts");
  const stale =
    !existsSync(bundle) ||
    !existsSync(types) ||
    statSync(bundle).mtimeMs < newestSource(resolve(root, "src"));
  if (stale) execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe" });
}
