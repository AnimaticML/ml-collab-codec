import type { ContentItem, DocumentModel } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import { type Diagnostic, type Result, diag, err, ok } from "./diagnostics.ts";
import { tokenize } from "./tokenizer.ts";
import { buildFragment } from "./build.ts";

/** Only nonfatal, precedence-preserving diagnostics may accompany a successful parse. */
function isFatal(d: Diagnostic): boolean {
  return d.code !== "duplicateAttribute";
}

export interface ParseOptions {
  /** "single" (default): exactly one root component. "multi": all roots retained. */
  readonly rootMode?: "single" | "multi";
}

/** Parse tagged source into ordered top-level content items, schema-validated. */
export function parseFragment(
  source: string,
  profile: SchemaProfile,
): { items: readonly ContentItem[]; diagnostics: readonly Diagnostic[] } {
  const tokenized = tokenize(source);
  const built = buildFragment(tokenized.nodes, profile, "$");
  return { items: built.items, diagnostics: [...tokenized.diagnostics, ...built.diagnostics] };
}

function isBlankText(item: ContentItem): boolean {
  return typeof item === "string" && item.trim().length === 0;
}

/** Parse a full document: schema-validated, defaulting to single-root mode. */
export function parseDocument(
  source: string,
  profile: SchemaProfile,
  options: ParseOptions = {},
): Result<DocumentModel> {
  const rootMode = options.rootMode ?? "single";
  const fragment = parseFragment(source, profile);
  const diagnostics = [...fragment.diagnostics];
  const roots = fragment.items.filter(
    (item): item is Exclude<ContentItem, string> => typeof item !== "string",
  );
  const strayText = fragment.items.filter((item) => !isBlankText(item) && typeof item === "string");

  if (rootMode === "single") {
    if (roots.length === 0) {
      diagnostics.push(diag("invalidNesting", "$", "document has no root component"));
      return err(diagnostics);
    }
    if (roots.length > 1 || strayText.length > 0) {
      diagnostics.push(
        diag("extraRoot", "$", "single-root mode allows exactly one top-level component"),
      );
      return err(diagnostics);
    }
    const root = roots[0];
    if (root === undefined || root.tag !== profile.rootTag) {
      diagnostics.push(diag("invalidValue", "$", `root must be <${profile.rootTag}>`));
      return err(diagnostics);
    }
    if (diagnostics.some(isFatal)) return err(diagnostics);
    return ok({ schemaId: profile.id, schemaVersion: profile.version, root }, diagnostics);
  }

  if (roots.length === 0) {
    diagnostics.push(diag("invalidNesting", "$", "document has no root component"));
    return err(diagnostics);
  }
  if (diagnostics.some(isFatal)) return err(diagnostics);
  const first = roots[0];
  if (first === undefined) return err(diagnostics);
  return ok({ schemaId: profile.id, schemaVersion: profile.version, root: first }, diagnostics);
}

/** Multi-root parse returning every top-level component, for explicit multi-root/container use. */
export function parseMultiRoot(
  source: string,
  profile: SchemaProfile,
): Result<readonly Exclude<ContentItem, string>[]> {
  const fragment = parseFragment(source, profile);
  const roots = fragment.items.filter(
    (item): item is Exclude<ContentItem, string> => typeof item !== "string",
  );
  if (fragment.diagnostics.some(isFatal)) return err(fragment.diagnostics);
  return ok(roots, fragment.diagnostics);
}
