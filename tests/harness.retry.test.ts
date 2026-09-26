import { describe, expect, it } from "vitest";

import { toAnthropicMessages, withMessageCacheBreakpoint } from "@/lib/ai/anthropic";
import { backoffDelay, classifyProviderError, runTurnWithRetry } from "@/lib/ai/retry";
import type { AiRetryInfo } from "@/lib/ai/types";
import { FakeProvider, httpError } from "./helpers/fake-provider";

const request = { model: "claude-opus-5", system: [], messages: [] };
const noSleep = { sleep: async () => {} };

describe("classifyProviderError", () => {
  it("sorts failures into the four buckets", () => {
    expect(classifyProviderError(httpError(529, "overloaded")).kind).toBe("retryable");
    expect(classifyProviderError(httpError(429)).kind).toBe("retryable");
    expect(classifyProviderError(httpError(500)).kind).toBe("retryable");
    expect(classifyProviderError(httpError(413)).kind).toBe("too_large");
    expect(classifyProviderError(new Error("prompt is too long: 250000 tokens")).kind).toBe("too_large");
    expect(classifyProviderError(httpError(401, "invalid x-api-key")).kind).toBe("fatal");
    const controller = new AbortController();
    controller.abort();
    expect(classifyProviderError(httpError(500), controller.signal).kind).toBe("aborted");
  });

  it("reads the server's requested wait", () => {
    const err = Object.assign(httpError(429), { headers: { "retry-after": "3" } });
    expect(classifyProviderError(err).retryAfterMs).toBe(3000);
    expect(classifyProviderError(httpError(429, "Please try again in 1m2.5s")).retryAfterMs).toBe(62_500);
  });

  it("backs off exponentially with a ceiling", () => {
    const info = { kind: "retryable" as const, message: "" };
    const opts = { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 };
    expect(backoffDelay(1, info, opts)).toBe(1000);
    expect(backoffDelay(2, info, opts)).toBe(2000);
    expect(backoffDelay(5, info, opts)).toBe(5000);
  });
});

describe("runTurnWithRetry", () => {
  it("retries transient failures and reports each retry", async () => {
    const provider = new FakeProvider([{ error: httpError(529) }, { error: httpError(503) }, { text: "ok" }]);
    const retries: AiRetryInfo[] = [];
    const slept: number[] = [];
    const result = await runTurnWithRetry(
      provider,
      request,
      { onRetry: (info) => retries.push(info) },
      { sleep: async (ms) => void slept.push(ms), random: () => 0 },
    );
    expect(result.text).toBe("ok");
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries[0].maxAttempts).toBe(4);
    expect(retries[0].reason).toContain("529");
    expect(slept).toEqual([500, 1000]);
  });

  it("gives up after maxAttempts", async () => {
    const provider = new FakeProvider(Array.from({ length: 5 }, () => ({ error: httpError(529) })));
    await expect(
      runTurnWithRetry(provider, request, {}, { ...noSleep, maxAttempts: 3 }),
    ).rejects.toMatchObject({ status: 529 });
    expect(provider.requests).toHaveLength(3);
  });

  it("never retries fatal errors or a turn that already streamed", async () => {
    const fatal = new FakeProvider([{ error: httpError(400, "bad request") }, { text: "never" }]);
    await expect(runTurnWithRetry(fatal, request, {}, noSleep)).rejects.toThrow("bad request");
    expect(fatal.requests).toHaveLength(1);

    const streamed = new FakeProvider([{ error: httpError(529), streamed: "partial" }, { text: "never" }]);
    await expect(runTurnWithRetry(streamed, request, {}, noSleep)).rejects.toMatchObject({ status: 529 });
    expect(streamed.requests).toHaveLength(1);
  });

  it("stops waiting when the run is cancelled mid-backoff", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider([{ error: httpError(529) }, { text: "never" }]);
    const pending = runTurnWithRetry(
      provider,
      { ...request, signal: controller.signal },
      { onRetry: () => controller.abort() },
      { baseDelayMs: 60_000 },
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(provider.requests).toHaveLength(1);
  });
});

describe("anthropic wire format", () => {
  it("echoes thinking blocks with their signature on assistant turns", () => {
    const wire = toAnthropicMessages({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "sig" },
            { type: "tool_use", id: "t1", name: "grep", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
      ],
    });
    expect(wire[1].content[0]).toEqual({ type: "thinking", thinking: "plan", signature: "sig" });
    expect(wire[2].content[0]).toMatchObject({ content: "(no output)" });
  });

  it("sends user images as base64 image blocks", () => {
    const wire = toAnthropicMessages({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: "AAAA" },
            { type: "text", text: "match this" },
          ],
        },
      ],
    });
    expect(wire[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("puts a cache breakpoint on the last cacheable block of the transcript", () => {
    const wire = withMessageCacheBreakpoint(
      toAnthropicMessages({
        messages: [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }, { type: "thinking", thinking: "x", signature: "s" }] },
        ],
      }),
    );
    const last = wire[1].content as { type: string; cache_control?: unknown }[];
    expect(last[0].cache_control).toEqual({ type: "ephemeral" });
    expect(last[1].cache_control).toBeUndefined();
    expect((wire[0].content as { cache_control?: unknown }[])[0].cache_control).toBeUndefined();
  });
});
