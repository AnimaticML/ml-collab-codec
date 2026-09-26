/** Stable diagnostic codes returned by the codec and validator. */
export type DiagnosticCode =
  | "invalidValue"
  | "missingRequired"
  | "unknownTag"
  | "unknownProperty"
  | "duplicateId"
  | "duplicateAttribute"
  | "ambiguousPath"
  | "malformedJson"
  | "malformedMarkup"
  | "unsafeKey"
  | "invalidUnicode"
  | "extraRoot"
  | "capabilityUnsupported"
  | "danglingReference"
  | "cycleDetected"
  | "limitExceeded"
  | "invalidNesting"
  | "invalidSchema";

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

/** A single diagnostic: stable code, data path, optional schema path/span/node ID. */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly path: string;
  readonly schemaPath?: string;
  readonly span?: SourceSpan;
  readonly nodeId?: string;
}

export class DiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    super(
      diagnostics.map((d) => `${d.code} at ${d.path}: ${d.message}`).join("; ") ||
        "diagnostic error",
    );
    this.diagnostics = diagnostics;
    this.name = "DiagnosticError";
  }
}

export function diag(
  code: DiagnosticCode,
  path: string,
  message: string,
  extra: Partial<Pick<Diagnostic, "schemaPath" | "span" | "nodeId">> = {},
): Diagnostic {
  return { code, path, message, ...extra };
}

/** The result of a fallible operation: either a value or collected diagnostics. */
export type Result<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export function ok<T>(value: T, diagnostics: readonly Diagnostic[] = []): Result<T> {
  return { ok: true, value, diagnostics };
}

export function err<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}
