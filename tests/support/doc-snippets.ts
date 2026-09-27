import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "./built.ts";

interface Snippet {
  readonly file: string;
  readonly index: number;
  readonly code: string;
}

/** Every ```ts block in the guides and README (all are complete programs). */
export function docSnippets(): Snippet[] {
  const files = [
    "README.md",
    ...readdirSync(resolve(root, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  return files.flatMap((file) =>
    [...readFileSync(resolve(root, file), "utf8").matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map(
      (match, index) => ({ file, index, code: match[1] ?? "" }),
    ),
  );
}

/** Write a snippet as a runnable program importing the package from source. */
export function materialize(snippet: Snippet): string {
  const directory = resolve(root, ".artifacts/doc-snippets");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${snippet.file.replace(/[/.]/g, "_")}_${snippet.index}.ts`);
  const source = snippet.code.replaceAll(
    'from "ml-collab-codec"',
    `from "${resolve(root, "src/index.ts")}"`,
  );
  writeFileSync(path, source);
  return path;
}
