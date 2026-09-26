import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Fixed generated paths only. Refuse symlinks rather than traversing them.
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["dist", "coverage", ".artifacts"]) {
  const target = resolve(root, name);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to clean a symlink: ${target}`);
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
