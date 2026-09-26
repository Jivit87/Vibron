/**
 * Groq adapter.
 *
 * Groq is the speed tier: open-weights models at very high tokens/sec. It
 * has no prompt caching and no adaptive thinking, so the neutral request is
 * down-converted to plain OpenAI-style chat completions:
 *
 *  - System blocks collapse into one `system` message (cache flags dropped).
 *  - `tool_use` / `tool_result` blocks become `tool_calls` / `role:"tool"`.
 *
 * Because there is no caching here, the context engine's job matters more,
 * not less — every token in the prefix is paid for on every turn.
 */

import Groq from "groq-sdk";

import { getApiKey } from "@/lib/ai/credentials";
import { getModel } from "@/lib/ai/models";
import { toOpenAiMessages } from "@/lib/ai/openai-messages";
import {
  MissingCredentialError,
  TRUNCATED_CALL_ERROR,
  type AiContent,
  type AiProvider,
  type AiStopReason,
  type AiToolCall,
  type AiTurnHandlers,
  type AiTurnRequest,
  type AiTurnResult,
} from "@/lib/ai/types";

const DEFAULT_MAX_TOKENS = 8_000;

let cachedClient: { key: string; client: Groq } | null = null;

async function client(): Promise<Groq> {
  const key = await getApiKey("groq");
  if (!key) throw new MissingCredentialError("groq");
  if (cachedClient?.key === key) return cachedClient.client;
  // Retries live in `runTurnWithRetry`; see the Anthropic adapter.
  const next = new Groq({ apiKey: key, maxRetries: 0 });
  cachedClient = { key, client: next };
  return next;
}

function normalizeStopReason(raw: string | null | undefined): AiStopReason {
  switch (raw) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

export const groqProvider: AiProvider = {
  id: "groq",

  isConfigured(): boolean {
    return Boolean(process.env.GROQ_API_KEY) || cachedClient !== null;
  },

  async runTurn(
    request: AiTurnRequest,
    handlers: AiTurnHandlers = {},
  ): Promise<AiTurnResult> {
    const groq = await client();
    const spec = getModel(request.model);
    // Groq counts the *reserved* completion budget against the account's
    // tokens-per-minute cap, so this must be a realistic number rather than
    // the model's ceiling.
    const maxTokens = Math.min(
      request.maxTokens ?? spec?.defaultMaxOutput ?? DEFAULT_MAX_TOKENS,
      spec?.maxOutput ?? DEFAULT_MAX_TOKENS,
    );

    const tools = request.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    const stream = await groq.chat.completions.create(
      {
        model: request.model.replace(/^groq:/, ""),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: toOpenAiMessages(request) as any,
        max_tokens: maxTokens,
        stream: true,
        ...(tools?.length ? { tools, tool_choice: "auto" as const } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    let text = "";
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    // Tool calls arrive fragmented across chunks, keyed by index.
    const partial = new Map<number, { id: string; name: string; args: string }>();
    const announced = new Set<number>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;

      const usage = (chunk as unknown as { x_groq?: { usage?: Record<string, number> } })
        .x_groq?.usage;
      if (usage) {
        promptTokens = usage.prompt_tokens ?? promptTokens;
        completionTokens = usage.completion_tokens ?? completionTokens;
      }

      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        handlers.onText?.(delta.content);
      }

      const deltaCalls = (delta as { tool_calls?: unknown[] }).tool_calls;
      if (!Array.isArray(deltaCalls)) continue;
      for (const raw of deltaCalls as Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>) {
        const entry = partial.get(raw.index) ?? { id: "", name: "", args: "" };
        if (raw.id) entry.id = raw.id;
        if (raw.function?.name) entry.name += raw.function.name;
        if (raw.function?.arguments) entry.args += raw.function.arguments;
        partial.set(raw.index, entry);
        if (entry.name && !announced.has(raw.index)) {
          announced.add(raw.index);
          handlers.onToolCallStart?.(entry.name);
        }
      }
    }

    // Keep malformed calls rather than dropping them: a silently vanished
    // call leaves the model believing it acted. The call goes back on the
    // wire with `{}` arguments (always parseable, so Groq accepts the next
    // turn) and `inputError` tells the loop to answer it with an error.
    const toolCalls: AiToolCall[] = [];
    for (const entry of partial.values()) {
      if (!entry.name) continue;
      let input: Record<string, unknown> = {};
      let inputError: string | undefined;
      if (entry.args.trim()) {
        try {
          const parsed = JSON.parse(entry.args) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          } else {
            inputError = "Tool arguments must be a JSON object.";
          }
        } catch {
          inputError = `Tool arguments were not valid JSON: ${entry.args.slice(0, 200)}`;
        }
      }
      toolCalls.push({
        id: entry.id || `call_${toolCalls.length}`,
        name: entry.name,
        input,
        ...(inputError ? { inputError } : {}),
      });
    }

    // Cut off by the output cap: the last call is incomplete even if it parses.
    const cut = finishReason === "length" ? toolCalls[toolCalls.length - 1] : undefined;
    if (cut) {
      if (!cut.inputError) cut.partialInput = cut.input;
      cut.input = {};
      cut.inputError = TRUNCATED_CALL_ERROR;
    }

    const content: AiContent[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of toolCalls) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }

    return {
      text,
      thinking: "",
      toolCalls,
      // "length" wins over "tool_use": the runner must know the turn was cut off.
      stopReason:
        finishReason === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : normalizeStopReason(finishReason),
      content,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  },
};
