/**
 * The model-provider hosts Viberon is actually using.
 *
 * These are implicitly allowed for the harness's own model calls (source
 * "provider"), whatever the mode: a policy that cut the agent off from its
 * model would make every other setting moot. The list is shown in Settings
 * so the exemption is never invisible. Other subsystems (browse, a sandboxed
 * script) get no implicit access to these hosts.
 */

import { allCredentialStatus } from "@/lib/ai/credentials";
import { geminiApiRoot } from "@/lib/ai/gemini-catalog";
import { nvidiaBaseUrl } from "@/lib/ai/nvidia-catalog";
import { resolveOpenAiCompatEnv } from "@/lib/ai/provider-config";
import type { ProviderId } from "@/lib/ai/types";

import { targetFromUrl } from "./host";

export interface ProviderHost {
  provider: ProviderId;
  host: string;
  baseUrl: string;
}

function baseUrlFor(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").trim();
    case "groq":
      return "https://api.groq.com/openai/v1";
    case "gemini":
      return geminiApiRoot();
    case "nvidia":
      return nvidiaBaseUrl();
    case "openai":
      return resolveOpenAiCompatEnv().baseUrl;
  }
}

/** Providers with a credential (or a keyless local endpoint) and their hosts. */
export async function providerHostsInUse(): Promise<ProviderHost[]> {
  const out: ProviderHost[] = [];
  let statuses: { provider: ProviderId; configured: boolean }[] = [];
  try {
    statuses = await allCredentialStatus();
  } catch {
    statuses = [];
  }
  const configured = new Set(statuses.filter((s) => s.configured).map((s) => s.provider));
  // A keyless OpenAI-compatible endpoint (Ollama, a local gateway) is in use
  // whenever a base URL is set.
  if (process.env.AI_BASE_URL || process.env.VIBERON_OPENAI_BASE_URL) configured.add("openai");

  for (const provider of configured) {
    const baseUrl = baseUrlFor(provider);
    const target = targetFromUrl(baseUrl);
    if (target && !out.some((p) => p.host === target.host)) {
      out.push({ provider, host: target.host, baseUrl });
    }
  }
  return out;
}
