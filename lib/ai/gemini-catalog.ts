/**
 * Google Gemini, driven entirely by the key's live model list.
 *
 * Gemini model names change every few months and old ones are shut down, so
 * nothing here is hard-coded. The native list endpoint
 * (`GET /v1beta/models`) returns every model the key can use together with
 * its real input/output token limits and whether it can chat
 * (`generateContent`). From that we register a short, ranked set of chat
 * models; the calls themselves go through Gemini's OpenAI-compatible
 * endpoint, so the existing adapter (tools, retries, text-protocol fallback)
 * applies unchanged.
 */

import { MODELS, registerModel, type ModelSpec, type ModelTier } from "@/lib/ai/models";

export const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;
/** Per variant (pro / flash / flash-lite), keep only the newest few versions. */
const PER_VARIANT = 2;

export function geminiApiRoot(): string {
  return (process.env.GEMINI_BASE_URL || GEMINI_API_ROOT).replace(/\/+$/, "");
}

/** Chat completions live under `/openai` on the same root. */
export function geminiOpenAiBase(): string {
  return `${geminiApiRoot()}/openai`;
}

interface NativeModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export interface GeminiModelInfo {
  id: string;
  label: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

let catalog: { key: string; at: number; models: GeminiModelInfo[] } | null = null;
const unavailable = new Set<string>();

/** Not chat models, or chat models the coding loop cannot use. */
const NON_CHAT = /embed|tts|image|imagen|veo|live|audio|native|robotics|computer-use|customtools|transcribe|aqa|learnlm|latest/;

/** Ranking key: newest version first, then pro > flash > flash-lite, stable before preview. */
function rank(id: string): { variant: string; version: number; stable: boolean } {
  const version = Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const variant = /flash-lite/.test(id) ? "flash-lite" : /flash/.test(id) ? "flash" : /pro/.test(id) ? "pro" : "other";
  return { variant, version, stable: !/preview|exp/.test(id) };
}

const VARIANT_ORDER = ["pro", "flash", "flash-lite", "other"];

/** Filter a native model list down to ranked chat models worth offering. */
export function selectGeminiModels(raw: NativeModel[]): GeminiModelInfo[] {
  const chat = raw
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({
      id: String(m.name ?? "").replace(/^models\//, ""),
      label: m.displayName || String(m.name ?? ""),
      inputTokenLimit: Number(m.inputTokenLimit) || 128_000,
      outputTokenLimit: Number(m.outputTokenLimit) || 8_192,
    }))
    .filter((m) => /^gemini-\d/.test(m.id) && !NON_CHAT.test(m.id));

  chat.sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    const variant = VARIANT_ORDER.indexOf(ra.variant) - VARIANT_ORDER.indexOf(rb.variant);
    if (variant !== 0) return variant;
    if (ra.version !== rb.version) return rb.version - ra.version;
    if (ra.stable !== rb.stable) return ra.stable ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const kept: GeminiModelInfo[] = [];
  const perVariant = new Map<string, number>();
  for (const m of chat) {
    const variant = rank(m.id).variant;
    const count = perVariant.get(variant) ?? 0;
    if (count >= PER_VARIANT) continue;
    perVariant.set(variant, count + 1);
    kept.push(m);
  }
  return kept;
}

function tierFor(id: string): ModelTier {
  const { variant } = rank(id);
  return variant === "pro" ? "frontier" : variant === "flash-lite" ? "fast" : "balanced";
}

export function geminiSpec(info: GeminiModelInfo): ModelSpec {
  const tier = tierFor(info.id);
  const maxOutput = Math.max(1_024, info.outputTokenLimit);
  return {
    id: `gemini:${info.id}`,
    provider: "gemini",
    label: `${info.label} (Gemini)`,
    blurb:
      tier === "frontier"
        ? "Google's strongest Gemini model. Free-tier keys have low per-minute limits."
        : tier === "fast"
          ? "Cheapest, fastest Gemini model for small mechanical steps."
          : "Fast Gemini model with strong coding and tool use.",
    tier,
    contextWindow: info.inputTokenLimit,
    maxOutput,
    defaultMaxOutput: Math.min(maxOutput, 32_000),
    // Usage is billed per key's plan; the free tier is not metered in USD.
    pricing: { input: 0, output: 0 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic: tier !== "fast",
  };
}

/**
 * The key's chat models, ranked, or null when the list could not be read.
 * Registers them in the model catalog as a side effect.
 */
export async function geminiCatalog(key: string | null): Promise<GeminiModelInfo[] | null> {
  if (!key) return null;
  if (catalog && catalog.key === key && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
  try {
    const response = await fetch(`${geminiApiRoot()}/models?pageSize=1000`, {
      headers: { "x-goog-api-key": key },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: NativeModel[] };
    const models = selectGeminiModels(body.models ?? []);
    if (models.length === 0) return null;
    for (const info of models) registerModel(geminiSpec(info));
    catalog = { key, at: Date.now(), models };
    return models;
  } catch {
    return null;
  }
}

export function markGeminiUnavailable(wireModel: string): void {
  unavailable.add(wireModel);
}

/** Usable = not known-dead, and listed by the catalog when the catalog is known. */
export function geminiModelUsable(wireModel: string, models: GeminiModelInfo[] | null): boolean {
  if (unavailable.has(wireModel)) return false;
  return models === null || models.some((m) => m.id === wireModel);
}

/** Registered Gemini specs, in preference order. */
export function geminiSpecs(): ModelSpec[] {
  return MODELS.filter((m) => m.provider === "gemini");
}

export const geminiCatalogTesting = {
  reset(): void {
    catalog = null;
    unavailable.clear();
    for (let i = MODELS.length - 1; i >= 0; i -= 1) {
      if (MODELS[i].provider === "gemini") MODELS.splice(i, 1);
    }
  },
};
