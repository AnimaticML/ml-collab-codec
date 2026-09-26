import type { ComponentNode, ContentItem, DocumentModel } from "./types.ts";
import type { SchemaProfile } from "./schema.ts";
import { type Diagnostic, type Result, diag, err, ok } from "./diagnostics.ts";
import { tokenize } from "./tokenizer.ts";
import { buildFragment } from "./build.ts";
import { normalizeDocument, normalizeFragment } from "./document-check.ts";

/** Only nonfatal, precedence-preserving diagnostics may accompany a successful parse. */
function isFatal(d: Diagnostic): boolean {
  return d.code !== "duplicateAttribute";
}

function decode(
  source: string,
  profile: SchemaProfile,
): { items: readonly unknown[]; diagnostics: Diagnostic[] } {
  const tokenized = tokenize(source);
  const built = buildFragment(tokenized.nodes, profile, "$");
  return { items: built.items, diagnostics: [...tokenized.diagnostics, ...built.diagnostics] };
}

/**
 * Parse top-level content that may mix text and components of any declared
 * tag (for example a clipboard fragment). Not a document: no root rule.
 */
export function parseFragment(
  source: string,
  profile: SchemaProfile,
): Result<readonly ContentItem[]> {
  const decoded = decode(source, profile);
  const normalized = normalizeFragment(decoded.items, profile, true);
  const diagnostics = [...decoded.diagnostics, ...normalized.diagnostics];
  return diagnostics.some(isFatal) ? err(diagnostics) : ok(normalized.items, diagnostics);
}

/** Parse a document: exactly one root component of the schema's root tag, nothing else. */
export function parseDocument(source: string, profile: SchemaProfile): Result<DocumentModel> {
  const decoded = decode(source, profile);
  const roots = decoded.items.filter((item) => typeof item !== "string");
  const text = decoded.items.filter((item) => typeof item === "string" && item.trim().length > 0);
  if (roots.length !== 1 || text.length > 0) {
    const message =
      roots.length === 0
        ? "document has no root component"
        : "a document has exactly one top-level component and no top-level text";
    return err([
      ...decoded.diagnostics,
      diag(roots.length === 0 ? "invalidNesting" : "extraRoot", "$", message),
    ]);
  }
  const normalized = normalizeDocument(roots[0], profile);
  const diagnostics = [...decoded.diagnostics, ...normalized.diagnostics];
  if (normalized.root === undefined || diagnostics.some(isFatal)) return err(diagnostics);
  return ok(
    { schemaId: profile.id, schemaVersion: profile.version, root: normalized.root },
    diagnostics,
  );
}

/**
 * Parse a multi-root container: returns every top-level component, in
 * order, with one shared id space. Significant top-level text is an error
 * rather than being dropped.
 */
export function parseMultiRoot(
  source: string,
  profile: SchemaProfile,
): Result<readonly ComponentNode[]> {
  const decoded = decode(source, profile);
  const normalized = normalizeFragment(decoded.items, profile, false);
  const diagnostics = [...decoded.diagnostics, ...normalized.diagnostics];
  const roots = normalized.items.filter((item): item is ComponentNode => typeof item !== "string");
  if (roots.length === 0) diagnostics.push(diag("invalidNesting", "$", "no top-level component"));
  return diagnostics.some(isFatal) ? err(diagnostics) : ok(roots, diagnostics);
}
