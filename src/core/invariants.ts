import type { Change } from "./change.ts";
import type { SchemaProfile } from "./schema.ts";
import { getComponentSchema, propertyAtPath } from "./schema.ts";
import type { Table } from "./table.ts";
import { incrementalIssues } from "./validate.ts";

/**
 * A trusted final-candidate check. It sees the accepted state before the
 * request, the complete candidate, and the effective primitives; it returns
 * a safe reason string to reject, or null. Validators are registered by
 * code, never loaded from documents.
 */
export type CandidateValidator = (
  candidate: Table,
  changes: readonly Change[],
  before: Table,
) => string | null;

/**
 * The recommended schema-backed validator (SPEC 7, v3 §5.1): every final
 * candidate must satisfy the declared schema -- property types and
 * constraints at every depth, required fields, content modes, allowed
 * nesting, identity, and domain references anywhere in the document -- and
 * relative deltas are accepted only on fields declared `x-additive`.
 * Constraints come from the trusted schema, never from a client payload.
 * Intermediate states inside one request may be invalid.
 */
export function schemaValidator(profile: SchemaProfile): CandidateValidator {
  return (candidate, changes, before) => {
    for (const change of changes) {
      if (change.kind !== "delta") continue;
      const props = getComponentSchema(profile, candidate.get(change.node)?.tag ?? "")?.props;
      if (propertyAtPath(props, change.path)?.additive !== true)
        return "delta targets a field that is not declared additive";
    }
    const issues = incrementalIssues(profile, before, candidate, changes);
    const first = issues[0];
    return first === undefined ? null : `schema: ${first.path}: ${first.message}`;
  };
}
