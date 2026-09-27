import { exportComponentProperties } from "../src/core/provider-export.ts";
import type { ProviderExport } from "../src/core/provider-export.ts";
import { decodeProviderResponse } from "../src/core/provider-decode.ts";
import type { ProviderResponse } from "../src/core/provider-decode.ts";
import { PROVIDER_PROFILES } from "../src/core/provider-profiles.ts";
import type { ProviderId } from "../src/core/provider-profiles.ts";
import { outlineSchema } from "../tests/support/provider-fixture.ts";

/**
 * Opt-in live structured-output probes (SPEC 12.3, MR18). Nothing is sent
 * unless PROBE_LIVE=1 and that provider's credential variable is set; each
 * probe sends only the synthetic outline fixture's section schema and a
 * fixed synthetic prompt (never private documents). Output is one JSON line
 * per provider with the API mode, model, date, and status
 * (passed | failed | skipped | error). Credentials are read from the
 * environment and never printed. The request shapes follow the provider
 * documentation retrieved on the profile date; an API change shows up as
 * `error`, not as fabricated success.
 */
interface ProbeResult {
  readonly provider: ProviderId;
  readonly apiMode: string;
  readonly model: string;
  readonly date: string;
  readonly status: "passed" | "failed" | "skipped" | "error";
  readonly detail: string;
}

const PROMPT =
  "Return a section for a user guide: heading 'Getting started', slug 'getting-started', level 2, tags ['intro','setup'].";

const CREDENTIALS: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const MODELS: Record<ProviderId, string> = {
  openai: process.env["PROBE_OPENAI_MODEL"] ?? "gpt-4.1-mini",
  anthropic: process.env["PROBE_ANTHROPIC_MODEL"] ?? "claude-sonnet-4-5",
  gemini: process.env["PROBE_GEMINI_MODEL"] ?? "gemini-2.5-flash",
};

type Json = Record<string, unknown>;

async function post(url: string, headers: Record<string, string>, body: Json): Promise<Json> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Json;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return json;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function callOpenAI(key: string, exported: ProviderExport): Promise<ProviderResponse> {
  const json = await post(
    "https://api.openai.com/v1/responses",
    { authorization: `Bearer ${key}` },
    {
      model: MODELS.openai,
      input: PROMPT,
      text: {
        format: {
          type: "json_schema",
          name: "section",
          schema: exported.requestSchema,
          strict: true,
        },
      },
    },
  );
  const content = ((json["output"] ?? []) as Json[]).flatMap(
    (item) => (item["content"] ?? []) as Json[],
  );
  const refusal = content.find((c) => c["type"] === "refusal");
  if (refusal !== undefined) return { status: "refusal", reason: text(refusal["refusal"]) };
  if (json["status"] === "incomplete") return { status: "incomplete", partialJson: "" };
  return { status: "ok", json: text(content.find((c) => c["type"] === "output_text")?.["text"]) };
}

async function callAnthropic(key: string, exported: ProviderExport): Promise<ProviderResponse> {
  const json = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    {
      model: MODELS.anthropic,
      max_tokens: 1024,
      messages: [{ role: "user", content: PROMPT }],
      output_config: { format: { type: "json_schema", schema: exported.requestSchema } },
    },
  );
  if (json["stop_reason"] === "refusal") return { status: "refusal", reason: "refusal" };
  if (json["stop_reason"] === "max_tokens") return { status: "incomplete", partialJson: "" };
  const block = ((json["content"] ?? []) as Json[]).find((c) => c["type"] === "text");
  return { status: "ok", json: text(block?.["text"]) };
}

async function callGemini(key: string, exported: ProviderExport): Promise<ProviderResponse> {
  const json = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`,
    { "x-goog-api-key": key },
    {
      contents: [{ parts: [{ text: PROMPT }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: exported.requestSchema,
      },
    },
  );
  const candidate = ((json["candidates"] ?? []) as Json[])[0] ?? {};
  if (candidate["finishReason"] === "MAX_TOKENS") return { status: "incomplete", partialJson: "" };
  const parts = ((candidate["content"] as Json | undefined)?.["parts"] ?? []) as Json[];
  return { status: "ok", json: parts.map((p) => text(p["text"])).join("") };
}

const CALLS: Record<
  ProviderId,
  (key: string, exported: ProviderExport) => Promise<ProviderResponse>
> = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
};

async function probe(provider: ProviderId): Promise<ProbeResult> {
  const profile = PROVIDER_PROFILES[provider];
  const base = {
    provider,
    apiMode: profile.apiMode,
    model: MODELS[provider],
    date: new Date().toISOString().slice(0, 10),
  };
  if (process.env["PROBE_LIVE"] !== "1")
    return { ...base, status: "skipped", detail: "live probes are opt-in (PROBE_LIVE=1)" };
  const key = process.env[CREDENTIALS[provider]];
  if (key === undefined || key.length === 0)
    return { ...base, status: "skipped", detail: `${CREDENTIALS[provider]} is not set` };
  const exported = exportComponentProperties(outlineSchema, "section", provider);
  try {
    const response = await CALLS[provider](key, exported);
    const decoded = decodeProviderResponse(response, exported, outlineSchema);
    return decoded.ok
      ? { ...base, status: "passed", detail: "response decoded under the local contract" }
      : { ...base, status: "failed", detail: decoded.diagnostics.map((d) => d.message).join("; ") };
  } catch (error) {
    // Report the failure class only; never echo request headers or bodies.
    return {
      ...base,
      status: "error",
      detail: error instanceof Error ? error.message : "request failed",
    };
  }
}

const only = process.argv.slice(2) as ProviderId[];
for (const provider of only.length > 0 ? only : (["openai", "anthropic", "gemini"] as const))
  console.log(JSON.stringify(await probe(provider)));
