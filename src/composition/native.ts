import { getAtPath } from "../core/json-path.ts";
import type { ComponentDefinition, JsonSchema } from "../core/schema-definition.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { isJsonObject } from "../core/types.ts";

function node(
  properties: Record<string, JsonSchema>,
  required: string[],
  allowedTags?: readonly string[],
): ComponentDefinition {
  return {
    identity: "stable",
    content: allowedTags === undefined ? { mode: "none" } : { mode: "element", allowedTags },
    props: { type: "object", properties, required, additionalProperties: false },
  };
}

const text = { type: "string" } as const;
const object = { type: "object", additionalProperties: true } as const;

/** Version 1 declarations. The host chooses allowed parents for definition and occurrence nodes. */
export const compositionComponents = {
  compositionDefinition: node(
    {
      version: text,
      dependencies: { ...object, additionalProperties: text },
      fragment: { type: "array", items: { anyOf: [object, text] } },
    },
    ["version"],
    ["compositionField"],
  ),
  compositionField: node(
    {
      scope: text,
      path: text,
      label: text,
      contract: object,
      required: { type: "boolean" },
      when: object,
      target: text,
      property: text,
    },
    ["scope", "path"],
  ),
  compositionOccurrence: node(
    { definition: text, version: text, scope: text, values: object, repeat: text },
    ["definition", "version", "scope"],
    ["compositionItem"],
  ),
  compositionItem: node({ values: object }, []),
} satisfies Record<string, ComponentDefinition>;

export interface CompositionDiagnostic {
  readonly at: string;
  readonly message: string;
}

export class CompositionError extends Error {
  constructor(readonly diagnostics: readonly CompositionDiagnostic[]) {
    super(diagnostics.map(({ at, message }) => `${at}: ${message}`).join("\n"));
  }
}

export function fail(at: string, message: string): never {
  throw new CompositionError([{ at, message }]);
}

export function record(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function token(value: JsonValue | undefined, at: string): string {
  if (typeof value !== "string" || value.length === 0) fail(at, "expected nonempty text");
  return value;
}

/** Exact case-sensitive segments. Dots are separators and there are no escapes. */
export function segments(path: string): string[] {
  const parts = path.split(".");
  if (
    parts.length > 24 ||
    parts.some(
      (part) =>
        !/^[A-Za-z_][A-Za-z_0-9-]{0,63}$/.test(part) ||
        ["constructor", "prototype", "__proto__"].includes(part),
    )
  )
    fail(path, "invalid canonical path");
  return parts;
}

export function readPath(values: JsonObject, path: string): JsonValue | undefined {
  return getAtPath(values, segments(path));
}
