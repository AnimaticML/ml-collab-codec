/**
 * Evidence-based structured-output profiles (SPEC 12.3). Each entry records
 * what the named provider documentation stated on the retrieval date, and
 * labels every numeric budget as `documented` (a provider limit quoted from
 * its documentation) or `internal` (a conservative budget chosen by this
 * library because the documentation gave no single number). These are not
 * live-verified guarantees: `bun run probe:live` checks them when credentials
 * are available, and absence of that evidence is reported, not assumed.
 */
export type ProviderId = "openai" | "anthropic" | "gemini";

export interface Budget {
  readonly value: number;
  readonly basis: "documented" | "internal";
  readonly note: string;
}

export interface ProviderProfile {
  readonly id: ProviderId;
  readonly apiMode: string;
  readonly models: string;
  readonly retrieved: string;
  readonly sources: readonly string[];
  /** Recursive `$ref` (for example `#/$defs/node` referring to itself) is accepted. */
  readonly recursion: boolean;
  /** `nullable`: every property must be listed in `required`; unset is expressed as null. */
  readonly optionalProperties: "allowed" | "nullable";
  /** Assertion keywords the provider enforces during generation. */
  readonly enforced: ReadonlySet<string>;
  /** `const` is accepted; otherwise a scalar const is emitted as a one-value enum. */
  readonly constKeyword: boolean;
  /** Anthropic accepts only 0 or 1 for minItems. */
  readonly minItemsValues?: readonly number[];
  /** Enum members must be scalars (no objects/arrays). */
  readonly scalarEnums: boolean;
  readonly maxDepth: Budget;
  readonly maxProperties: Budget;
}

const RETRIEVED = "2026-09-27";

export const PROVIDER_PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
  openai: {
    id: "openai",
    apiMode:
      "Structured Outputs, strict json_schema (Responses text.format / Chat response_format)",
    models: "models listed as supporting Structured Outputs",
    retrieved: RETRIEVED,
    sources: [
      "https://developers.openai.com/api/docs/guides/structured-outputs",
      "https://community.openai.com/t/structured-outputs-limits-are-raised-to-support-larger-schemas/1313593",
    ],
    recursion: true,
    optionalProperties: "nullable",
    enforced: new Set([
      "type",
      "enum",
      "anyOf",
      "required",
      "additionalProperties",
      "items",
      "properties",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
    ]),
    constKeyword: false,
    scalarEnums: false,
    maxDepth: {
      value: 5,
      basis: "internal",
      note: "earlier OpenAI and current Azure text state 5 nesting levels; the current OpenAI page did not show a number when retrieved",
    },
    maxProperties: {
      value: 100,
      basis: "internal",
      note: "documented as 100, later reported raised to 5,000 (secondary source); 100 kept as a conservative budget",
    },
  },
  anthropic: {
    id: "anthropic",
    apiMode: "JSON outputs output_config.format json_schema / strict tool input_schema",
    models: "Claude models listed as GA for structured outputs",
    retrieved: RETRIEVED,
    sources: ["https://platform.claude.com/docs/en/docs/build-with-claude/structured-outputs"],
    recursion: false,
    optionalProperties: "allowed",
    enforced: new Set([
      "type",
      "enum",
      "const",
      "anyOf",
      "required",
      "additionalProperties",
      "items",
      "properties",
      "format",
      "minItems",
    ]),
    constKeyword: true,
    minItemsValues: [0, 1],
    scalarEnums: true,
    maxDepth: {
      value: 8,
      basis: "internal",
      note: "no documented nesting limit; conservative internal budget",
    },
    maxProperties: {
      value: 200,
      basis: "internal",
      note: "no documented property limit; conservative internal budget",
    },
  },
  gemini: {
    id: "gemini",
    apiMode: "Gemini API structured output with a JSON Schema",
    models: "Gemini 3 series models",
    retrieved: RETRIEVED,
    sources: ["https://ai.google.dev/gemini-api/docs/structured-output"],
    recursion: true,
    optionalProperties: "allowed",
    enforced: new Set([
      "type",
      "enum",
      "anyOf",
      "required",
      "additionalProperties",
      "items",
      "properties",
      "format",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
    ]),
    constKeyword: false,
    scalarEnums: false,
    maxDepth: {
      value: 8,
      basis: "internal",
      note: "documentation says very large or deeply nested schemas may be rejected, without a number",
    },
    maxProperties: {
      value: 200,
      basis: "internal",
      note: "no documented property limit; conservative internal budget",
    },
  },
};
