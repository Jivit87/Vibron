/**
 * Anthropic adapter.
 *
 * Claude is the primary driver for Viberon's agent loops — it is by a wide
 * margin the strongest model family at long-horizon tool use, which is
 * exactly what "build me a full-stack app" needs.
 *
 * Three things here are load-bearing for token economics:
 *
 *  - **Prompt caching.** The system prompt is sent as blocks, and the last
 *    block flagged `cache: true` gets a `cache_control` breakpoint. Project
 *    memory + repo skeleton + tool conventions sit before that breakpoint,
 *    so every follow-up turn re-reads them at ~0.1x price instead of full.
 *  - **Adaptive thinking.** Claude decides its own reasoning depth; we ask
 *    for a summarized display so the UI can render the agent's plan live.
 *  - **Effort.** `output_config.effort` is the main cost/quality dial and
 *    is set per specialist role rather than globally.
 *
 * API surface notes (Opus 5 / Sonnet 5): `temperature`, `top_p`, and `top_k`
 * are rejected outright, `budget_tokens` is gone in favour of adaptive
 * thinking, and a safety decline arrives as a 200 with
 * `stop_reason: "refusal"` — so `content` must never be indexed blindly.
 */

import Anthropic from "@anthropic-ai/sdk";

import { getApiKey } from "@/lib/ai/credentials";
import { getModel, outputCap } from "@/lib/ai/models";
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

/** Streaming is mandatory above ~16k output tokens to dodge HTTP timeouts. */
const DEFAULT_MAX_TOKENS = 32_000;

let cachedClient: { key: string; client: Anthropic } | null = null;

async function client(): Promise<Anthropic> {
  const key = await getApiKey("anthropic");
  if (!key) throw new MissingCredentialError("anthropic");
  if (cachedClient?.key === key) return cachedClient.client;
  // Retries live in `runTurnWithRetry`, which also knows not to replay a
  // turn whose text already streamed. Two layers would multiply attempts.
  const next = new Anthropic({ apiKey: key, maxRetries: 0 });
  cachedClient = { key, client: next };
  return next;
}

/**
 * Build the `system` array, placing a single cache breakpoint after the last
 * block marked cacheable. Anthropic allows at most four breakpoints per
 * request; one is all we need because the stable prefix is contiguous.
 */
function buildSystem(request: AiTurnRequest) {
  const blocks = request.system.filter((b) => b.text.trim().length > 0);
  if (blocks.length === 0) return undefined;

  let lastCacheable = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].cache) lastCacheable = i;
  }

  return blocks.map((block, index) => {
    const base = { type: "text" as const, text: block.text };
    return index === lastCacheable
      ? { ...base, cache_control: { type: "ephemeral" as const } }
      : base;
  });
}

/**
 * Translate our neutral content blocks into Anthropic's message params.
 *
 * Also defends the wire against shapes the API rejects outright: empty text
 * blocks, and messages left with no content at all (a turn that produced
 * only whitespace). Thinking blocks are echoed unchanged — a tool loop on a
 * thinking model must hand them back with their signatures intact.
 */
export function toAnthropicMessages(request: Pick<AiTurnRequest, "messages">) {
  return request.messages.map((message) => {
    const content = message.content.flatMap((block): Anthropic.ContentBlockParam[] => {
      switch (block.type) {
        case "text":
          return block.text.trim()
            ? [{ type: "text" as const, text: block.text }]
            : [];
        case "thinking":
          return message.role === "assistant"
            ? [
                {
                  type: "thinking" as const,
                  thinking: block.thinking,
                  signature: block.signature,
                },
              ]
            : [];
        case "redacted_thinking":
          return message.role === "assistant"
            ? [{ type: "redacted_thinking" as const, data: block.data }]
            : [];
        case "image":
          return message.role === "user"
            ? [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: block.mediaType,
                    data: block.data,
                  },
                },
              ]
            : [];
        case "tool_use":
          return [
            {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: block.input,
            },
          ];
        case "tool_result":
          return [
            {
              type: "tool_result" as const,
              tool_use_id: block.tool_use_id,
              // An empty result is legal, but a marker reads better to the
              // model than silence.
              content: block.content || "(no output)",
              ...(block.is_error ? { is_error: true } : {}),
            },
          ];
        default:
          return [];
      }
    });
    return {
      role: message.role,
      content:
        content.length > 0
          ? content
          : [{ type: "text" as const, text: "(empty)" }],
    };
  });
}

/**
 * Put a second cache breakpoint on the last cacheable block of the
 * transcript. Each turn of a tool loop re-sends everything before it, so
 * marking the tail means turn N+1 reads turn N's whole prefix from cache
 * instead of paying full price for the growing transcript. Thinking blocks
 * cannot carry `cache_control`, so the walk skips them.
 */
export function withMessageCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const content = messages[m].content;
    if (typeof content === "string") continue;
    for (let b = content.length - 1; b >= 0; b -= 1) {
      const type = content[b].type;
      if (type === "thinking" || type === "redacted_thinking") continue;
      const next = [...content];
      next[b] = {
        ...content[b],
        cache_control: { type: "ephemeral" as const },
      } as Anthropic.ContentBlockParam;
      const copy = [...messages];
      copy[m] = { ...messages[m], content: next };
      return copy;
    }
  }
  return messages;
}

function normalizeStopReason(raw: string | null | undefined): AiStopReason {
  switch (raw) {
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
    case "stop_sequence":
    case "end_turn":
      return raw;
    default:
      return "end_turn";
  }
}

export const anthropicProvider: AiProvider = {
  id: "anthropic",

  isConfigured(): boolean {
    // Synchronous best-effort: the async path in `getApiKey` is authoritative,
    // but callers use this only to decide whether to *offer* the provider.
    return Boolean(process.env.ANTHROPIC_API_KEY) || cachedClient !== null;
  },

  async runTurn(
    request: AiTurnRequest,
    handlers: AiTurnHandlers = {},
  ): Promise<AiTurnResult> {
    const anthropic = await client();
    const spec = getModel(request.model);
    const maxTokens = spec ? outputCap(spec, request.maxTokens) : (request.maxTokens ?? DEFAULT_MAX_TOKENS);

    // Effort and adaptive thinking are model-gated. Sending either to a
    // model that does not support it is a 400, so gate on the catalog.
    const extras: Record<string, unknown> = {};
    if (spec?.supportsEffort && request.effort) {
      extras.output_config = { effort: request.effort };
    }
    if (spec?.supportsThinking) {
      extras.thinking = {
        type: "adaptive",
        // Default is "omitted", which streams empty thinking blocks and
        // reads as a long silent pause in the UI. We always want the summary.
        display: request.showThinking === false ? "omitted" : "summarized",
      };
    }

    const stream = anthropic.messages.stream(
      {
        model: request.model,
        max_tokens: maxTokens,
        system: buildSystem(request),
        messages: spec?.supportsCaching === false
          ? toAnthropicMessages(request)
          : withMessageCacheBreakpoint(toAnthropicMessages(request)),
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...extras,
        // NOTE: no temperature / top_p / top_k — rejected on Opus 5 & Sonnet 5.
      } as Anthropic.MessageCreateParamsStreaming,
      request.signal ? { signal: request.signal } : undefined,
    );

    let text = "";
    let thinking = "";

    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          handlers.onToolCallStart?.(block.name);
        }
        return;
      }
      if (event.type !== "content_block_delta") return;
      const delta = event.delta;
      if (delta.type === "text_delta") {
        text += delta.text;
        handlers.onText?.(delta.text);
      } else if (delta.type === "thinking_delta") {
        thinking += delta.thinking;
        handlers.onThinking?.(delta.thinking);
      }
    });

    const message = await stream.finalMessage();

    // A safety decline is a successful HTTP 200 with an empty or partial
    // `content` array — never index into it before checking stop_reason.
    const stopReason = normalizeStopReason(message.stop_reason);
    const refusal =
      stopReason === "refusal"
        ? {
            category:
              (message as { stop_details?: { category?: string | null } })
                .stop_details?.category ?? null,
            explanation: (
              message as { stop_details?: { explanation?: string } }
            ).stop_details?.explanation,
          }
        : undefined;

    const toolCalls: AiToolCall[] = [];
    const content: AiContent[] = [];
    // At max_tokens the last tool_use is cut off mid-arguments, and the SDK's
    // partial-JSON parse silently drops the unfinished string: a truncated
    // write_file arrives as `{ path }` with no content. Never hand that on.
    const lastToolUse =
      stopReason === "max_tokens" ? message.content.findLastIndex((b) => b.type === "tool_use") : -1;
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        content.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (block.type === "redacted_thinking") {
        content.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "tool_use") {
        // Anything that is not a plain object (a truncated or malformed
        // call) is flagged rather than handed to a tool expecting named
        // arguments.
        const raw = block.input;
        const truncated = index === lastToolUse;
        const valid =
          !truncated && Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
        const call: AiToolCall = {
          id: block.id,
          name: block.name,
          input: valid ? (raw as Record<string, unknown>) : {},
          ...(valid
            ? {}
            : {
                inputError: truncated
                  ? TRUNCATED_CALL_ERROR
                  : "Tool arguments were not a JSON object.",
              }),
          ...(truncated && raw && typeof raw === "object" ? { partialInput: raw as Record<string, unknown> } : {}),
        };
        toolCalls.push(call);
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      // Thinking blocks ARE kept: the agent loop continues the same
      // conversation turn after turn, and a thinking model expects its
      // reasoning (signature included) handed back alongside the tool_use
      // it led to. Dropping them silently degrades every multi-step run.
    }

    const usage = message.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };

    return {
      text,
      thinking,
      toolCalls,
      stopReason,
      refusal,
      content,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  },
};
