import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { availableModels, resolveModel, runTurn } from "@/lib/ai";
import { getApiKey, invalidateCredentialCache } from "@/lib/ai/credentials";
import { geminiCatalogTesting, selectGeminiModels } from "@/lib/ai/gemini-catalog";
import { getModel } from "@/lib/ai/models";
import { nvidiaCatalogTesting } from "@/lib/ai/nvidia-catalog";
import { openAiCompatTesting } from "@/lib/ai/openai-compat";
import type { AiToolDef, AiTurnRequest } from "@/lib/ai/types";

const ENV_KEYS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "VIBERON_MODEL",
  "VIBERON_STORE",
];
const saved: Record<string, string | undefined> = {};

const ROOT = "https://generativelanguage.googleapis.com/v1beta";

/** A native model list the way the Gemini API returns it. */
const NATIVE = [
  { name: "models/gemini-9.0-pro", displayName: "Gemini 9.0 Pro", inputTokenLimit: 2_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-9.0-flash", displayName: "Gemini 9.0 Flash", inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-8.5-flash", displayName: "Gemini 8.5 Flash", inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-8.0-flash", displayName: "Gemini 8.0 Flash", inputTokenLimit: 1_000_000, outputTokenLimit: 8_192, supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-9.0-flash-lite", displayName: "Gemini 9.0 Flash-Lite", inputTokenLimit: 1_000_000, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-9.0-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
  { name: "models/gemini-flash-latest", displayName: "Latest alias", supportedGenerationMethods: ["generateContent"] },
];

function request(model: string): AiTurnRequest {
  return {
    model,
    system: [{ text: "SYS" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

const okChat = () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    { status: 200 },
  );

/** Serves the native catalog and records chat calls; `chat` decides chat responses. */
function stubGemini(chat: (model: string) => Response = okChat) {
  const calls: { url: string; headers: Record<string, string>; model?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (String(url).startsWith(`${ROOT}/models`)) {
        calls.push({ url, headers });
        return new Response(JSON.stringify({ models: NATIVE }), { status: 200 });
      }
      const model = String((JSON.parse(String(init?.body)) as { model: string }).model);
      calls.push({ url, headers, model });
      return chat(model);
    }),
  );
  return calls;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VIBERON_STORE = "memory";
  invalidateCredentialCache();
  openAiCompatTesting.reset();
  openAiCompatTesting.setSleep(async () => {});
  geminiCatalogTesting.reset();
  nvidiaCatalogTesting.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidateCredentialCache();
  vi.unstubAllGlobals();
});

describe("Gemini catalog", () => {
  it("keeps chat models only, newest first, pro > flash > flash-lite, two per variant", () => {
    expect(selectGeminiModels(NATIVE).map((m) => m.id)).toEqual([
      "gemini-9.0-pro",
      "gemini-9.0-flash",
      "gemini-8.5-flash",
      "gemini-9.0-flash-lite",
    ]);
  });

  it("registers the key's models with their real limits and picks Pro on auto", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const calls = stubGemini();
    const gemini = (await availableModels()).filter((m) => m.spec.provider === "gemini");
    expect(gemini.map((m) => m.spec.id)).toEqual([
      "gemini:gemini-9.0-pro",
      "gemini:gemini-9.0-flash",
      "gemini:gemini-8.5-flash",
      "gemini:gemini-9.0-flash-lite",
    ]);
    expect(gemini.every((m) => m.available)).toBe(true);
    expect(getModel("gemini:gemini-9.0-pro")?.contextWindow).toBe(2_000_000);
    expect(calls[0].headers["x-goog-api-key"]).toBe("AIza-test");
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("gemini:gemini-9.0-pro");
  });
});

describe("Gemini provider", () => {
  it("routes chat to the OpenAI-compatible endpoint with the Gemini key", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const calls = stubGemini();
    await availableModels();
    const res = await runTurn(request("gemini:gemini-9.0-flash"));
    expect(res.text).toBe("ok");
    const chat = calls.find((c) => c.model);
    expect(chat?.url).toBe(`${ROOT}/openai/chat/completions`);
    expect(chat?.headers.Authorization).toBe("Bearer AIza-test");
    expect(chat?.model).toBe("gemini-9.0-flash");
  });

  it("routes an AIza AI_API_KEY to the Gemini credential", async () => {
    process.env.AI_API_KEY = "AIza-from-env";
    expect(await getApiKey("gemini")).toBe("AIza-from-env");
    expect(await getApiKey("nvidia")).toBeNull();
  });

  it("falls back to the next Gemini model when one is shut down", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const calls = stubGemini((model) =>
      model === "gemini-9.0-pro" ? new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 }) : okChat(),
    );
    await availableModels();
    const res = await runTurn(request("gemini:gemini-9.0-pro"));
    expect(res.model).toBe("gemini:gemini-9.0-flash");
    await runTurn(request("gemini:gemini-9.0-pro"));
    expect(calls.filter((c) => c.model === "gemini-9.0-pro").length).toBe(1);
  });

  it("treats a daily quota as exhausted for the run but retries a per-minute limit", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    stubGemini((model) =>
      model === "gemini-9.0-pro"
        ? new Response(JSON.stringify({ error: { message: "Quota exceeded for GenerateRequestsPerDayPerProjectPerModel" } }), { status: 429 })
        : okChat(),
    );
    await availableModels();
    const res = await runTurn(request("gemini:gemini-9.0-pro"));
    expect(res.model).toBe("gemini:gemini-9.0-flash");
  });

  it("echoes each call's thought signature back to Gemini, and a bypass for unsigned calls", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith(`${ROOT}/models`)) return new Response(JSON.stringify({ models: NATIVE }), { status: 200 });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                      extra_content: { google: { thought_signature: "SIG-1" } },
                    },
                  ],
                },
              },
            ],
            usage: {},
          }),
          { status: 200 },
        );
      }),
    );
    await availableModels();
    const tools: AiToolDef[] = [
      { name: "read_file", description: "r", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ];
    const first = await runTurn({ ...request("gemini:gemini-9.0-flash"), tools });
    expect(first.toolCalls[0].extra).toEqual({ extra_content: { google: { thought_signature: "SIG-1" } } });
    await runTurn({
      ...request("gemini:gemini-9.0-flash"),
      tools,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_2", content: "y" }] },
      ],
    });
    const sent = (bodies[1].messages as { role: string; tool_calls?: { extra_content?: unknown }[] }[]).filter(
      (m) => m.role === "assistant",
    );
    expect(sent[0].tool_calls?.[0].extra_content).toEqual({ google: { thought_signature: "SIG-1" } });
    expect(sent[1].tool_calls?.[0].extra_content).toEqual({
      google: { thought_signature: "skip_thought_signature_validator" },
    });
  });

  it("treats a free-tier 'limit: 0' quota as unavailable and falls back at once", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const calls = stubGemini((model) =>
      model === "gemini-9.0-pro"
        ? new Response(
            JSON.stringify({ error: { message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-9.0-pro" } }),
            { status: 429 },
          )
        : okChat(),
    );
    await availableModels();
    const res = await runTurn(request("gemini:gemini-9.0-pro"));
    expect(res.model).toBe("gemini:gemini-9.0-flash");
    expect(calls.filter((c) => c.model === "gemini-9.0-pro").length).toBe(1);
  });

  it("prefers Gemini over NVIDIA and Groq at the same tier", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    process.env.NVIDIA_API_KEY = "nvapi-test";
    process.env.GROQ_API_KEY = "gsk_test";
    stubGemini();
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("gemini:gemini-9.0-pro");
  });
});
