import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { availableModels, resolveModel, runTurn } from "@/lib/ai";
import { getApiKey, invalidateCredentialCache } from "@/lib/ai/credentials";
import { getModel } from "@/lib/ai/models";
import { nvidiaCatalogTesting } from "@/lib/ai/nvidia-catalog";
import { NVIDIA_BASE_URL, nvidiaProvider, openAiCompatTesting } from "@/lib/ai/openai-compat";
import type { AiTurnRequest } from "@/lib/ai/types";

const ENV_KEYS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
  "VIBERON_MODEL",
  "VIBERON_STORE",
];
const saved: Record<string, string | undefined> = {};

function request(model: string): AiTurnRequest {
  return {
    model,
    system: [{ text: "SYS" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

function stubFetch() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Never read or write a real credential store from tests.
  process.env.VIBERON_STORE = "memory";
  invalidateCredentialCache();
  openAiCompatTesting.reset();
  openAiCompatTesting.setSleep(async () => {});
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

describe("NVIDIA provider", () => {
  it("with only an NVIDIA key, the solve preflight passes and review picks an NVIDIA model", async () => {
    const { ensureModelReady } = await import("@/lib/ai");
    const { reviewModel } = await import("@/lib/review");
    await expect(ensureModelReady("nvidia:qwen/qwen3-coder-480b-a35b-instruct")).rejects.toThrow(/No NVIDIA API key configured/);
    process.env.NVIDIA_API_KEY = "nvapi-test";
    invalidateCredentialCache();
    await expect(ensureModelReady("nvidia:qwen/qwen3-coder-480b-a35b-instruct")).resolves.toBeUndefined();
    expect(await reviewModel()).toMatch(/^nvidia:/);
  });


  it("sends catalog models to NVIDIA with the NVIDIA key and strips the prefix", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    const calls = stubFetch();
    const res = await nvidiaProvider.runTurn(request("nvidia:qwen/qwen3-coder-480b-a35b-instruct"));
    expect(res.text).toBe("ok");
    expect(calls[0].url).toBe(`${NVIDIA_BASE_URL}/chat/completions`);
    expect(calls[0].headers.Authorization).toBe("Bearer nvapi-test");
    expect(calls[0].body.model).toBe("qwen/qwen3-coder-480b-a35b-instruct");
  });

  it("ignores the generic OpenAI-compatible endpoint configuration", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    process.env.AI_BASE_URL = "https://other.example/v1";
    process.env.AI_API_KEY = "sk-other";
    const calls = stubFetch();
    await nvidiaProvider.runTurn(request("nvidia:openai/gpt-oss-120b"));
    expect(calls[0].url.startsWith(NVIDIA_BASE_URL)).toBe(true);
    expect(calls[0].headers.Authorization).toBe("Bearer nvapi-test");
  });

  it("honours NVIDIA_BASE_URL for a self-hosted NIM", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    process.env.NVIDIA_BASE_URL = "http://nim.local:8000/v1/";
    const calls = stubFetch();
    await nvidiaProvider.runTurn(request("nvidia:meta/llama-3.3-70b-instruct"));
    expect(calls[0].url).toBe("http://nim.local:8000/v1/chat/completions");
  });

  it("fails with a clear message when no NVIDIA key is configured", async () => {
    stubFetch();
    await expect(nvidiaProvider.runTurn(request("nvidia:openai/gpt-oss-120b"))).rejects.toThrow(
      /No NVIDIA API key configured/,
    );
  });

  it("routes an nvapi- AI_API_KEY to the NVIDIA credential", async () => {
    process.env.AI_API_KEY = "nvapi-from-env";
    expect(await getApiKey("nvidia")).toBe("nvapi-from-env");
    expect(await getApiKey("anthropic")).toBeNull();
  });

  it("accepts any catalog model as nvidia:<id>", () => {
    const spec = getModel("nvidia:mistralai/devstral-2-123b-instruct");
    expect(spec?.provider).toBe("nvidia");
    expect(spec?.label).toBe("mistralai/devstral-2-123b-instruct");
  });

  it("makes NVIDIA models available and picks the default on auto", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    // Catalog unreadable → every model is worth trying.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const models = await availableModels();
    const nvidia = models.filter((m) => m.spec.provider === "nvidia");
    expect(nvidia.length).toBeGreaterThan(0);
    expect(nvidia.every((m) => m.available)).toBe(true);
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("nvidia:nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("prefers NVIDIA over Groq on auto when both keys are configured", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    process.env.GROQ_API_KEY = "gsk_test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("nvidia:nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("only offers models the key's live catalog lists", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? new Response(JSON.stringify({ data: [{ id: "moonshotai/kimi-k3" }] }), { status: 200 })
          : new Response("{}", { status: 500 }),
      ),
    );
    const nvidia = (await availableModels()).filter((m) => m.spec.provider === "nvidia");
    expect(nvidia.filter((m) => m.available).map((m) => m.spec.id)).toEqual(["nvidia:moonshotai/kimi-k3"]);
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("nvidia:moonshotai/kimi-k3");
  });

  it("moves a run onto the next usable model when one is retired", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    const chatModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/models")) return new Response("{}", { status: 503 });
        const model = String((JSON.parse(String(init?.body)) as { model: string }).model);
        chatModels.push(model);
        if (model === "nvidia/nemotron-3-ultra-550b-a55b") {
          return new Response(JSON.stringify({ status: 410, detail: "end of life" }), { status: 410 });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
          { status: 200 },
        );
      }),
    );
    const first = await runTurn(request("nvidia:nvidia/nemotron-3-ultra-550b-a55b"));
    expect(first.model).toBe("nvidia:moonshotai/kimi-k3");
    expect(chatModels).toEqual(["nvidia/nemotron-3-ultra-550b-a55b", "moonshotai/kimi-k3"]);
    // Later turns skip the retired model without another failing request.
    await runTurn(request("nvidia:nvidia/nemotron-3-ultra-550b-a55b"));
    expect(chatModels.at(-1)).toBe("moonshotai/kimi-k3");
    expect(chatModels.filter((m) => m.startsWith("nvidia/nemotron-3-ultra")).length).toBe(1);
  });

  it("reports a clear error when no NVIDIA model is usable", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/models")
          ? new Response("{}", { status: 503 })
          : new Response("404 page not found", { status: 404 }),
      ),
    );
    await expect(runTurn(request("nvidia:nvidia/nemotron-3-ultra-550b-a55b"))).rejects.toThrow(
      /not available to this key \(HTTP 404\)/,
    );
  });
});
