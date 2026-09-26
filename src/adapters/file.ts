import { readFile, writeFile } from "node:fs/promises";

/** Local file open/save (SPEC 1): no room, server, database, or history required. */
export async function readDocumentFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function writeDocumentFile(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
}
