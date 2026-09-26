/**
 * Provider failure classification and retry.
 *
 * A long agent run makes dozens of model calls, so a single transient
 * failure — a 429, a 529 "overloaded", a dropped connection — must not end
 * it. But retrying the wrong failures is just as bad: a prompt that is too
 * large for the model will be too large on every attempt, and hammering it
 * burns the user's rate limit for nothing. So every failure is sorted into
 * one of four buckets before anything is decided:
 *
 *  - `aborted`    — the user cancelled; never retry.
 *  - `too_large`  — the request can never fit; the caller must shrink it.
 *  - `retryable`  — transient; back off and try again.
 *  - `fatal`      — bad key, bad request, unknown model; surface it.
 *
 * Retries only happen while nothing has streamed yet. Once text deltas have
 * reached the UI, replaying the request would print them twice.
 */

import type {
  AiProvider,
  AiTurnHandlers,
  AiTurnRequest,
  AiTurnResult,
} from "@/lib/ai/types";

export type ProviderErrorKind = "aborted" | "too_large" | "retryable" | "fatal";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  status?: number;
  /** Server-requested wait, from a retry-after header or the message text. */
  retryAfterMs?: number;
  message: string;
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function readRetryAfter(error: unknown, message: string): number | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers;
  const header = (name: string): string | null => {
    if (!headers || typeof headers !== "object") return null;
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  };

  const ms = header("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const raw = header("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  // Groq puts the wait in prose: "Please try again in 2.35s" / "in 1m3.2s".
  const prose = message.match(/try again in (?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (prose) {
    return Math.round(((Number(prose[1] ?? 0) * 60) + Number(prose[2])) * 1000);
  }
  return undefined;
}

export function classifyProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const status = readStatus(error);
  const lower = message.toLowerCase();

  if (
    signal?.aborted ||
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    /request was aborted|user aborted/i.test(message)
  ) {
    return { kind: "aborted", status, message };
  }

  // The model is gone for this key (retired, not enabled, daily quota used
  // up). Waiting cannot fix it; runTurn falls back to another model at once.
  if (name === "ModelUnavailableError") return { kind: "fatal", status, message };

  // A per-request token demand above the account's ceiling ("Limit 6000,
  // Requested 9000") arrives as a 413 or even a 429, but no amount of
  // waiting fixes it.
  const limit = message.match(/Limit (\d+)[^\d]+(?:Used \d+[^\d]+)?Requested (\d+)/i);
  const exceedsCeiling = limit ? Number(limit[2]) > Number(limit[1]) : false;
  if (
    status === 413 ||
    exceedsCeiling ||
    /too large|prompt is too long|context.{0,20}(length|window)|maximum context|reduce the length/i.test(
      message,
    )
  ) {
    return { kind: "too_large", status, message };
  }

  const retryAfterMs = readRetryAfter(error, message);

  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 529 ||
    (status !== undefined && status >= 500) ||
    lower.includes("overloaded") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("internal server error") ||
    lower.includes("service unavailable") ||
    lower.includes("bad gateway") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("connection error") ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError"
  ) {
    return { kind: "retryable", status, retryAfterMs, message };
  }

  return { kind: "fatal", status, message };
}

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** First backoff delay; doubles each attempt. Default 1000ms. */
  baseDelayMs?: number;
  /** Ceiling on any single wait. Default 30s. */
  maxDelayMs?: number;
  /** A server asking for a longer wait than this is treated as fatal. */
  maxRetryAfterMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** A setTimeout that wakes early (and rejects) when the run is cancelled. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(
  attempt: number,
  info: ProviderErrorInfo,
  options: RetryOptions = {},
): number {
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  if (info.retryAfterMs !== undefined) return Math.min(info.retryAfterMs, max * 2);
  const exp = base * 2 ** (attempt - 1);
  // Full jitter on the upper half, so parallel agents that failed together
  // do not all retry in the same millisecond.
  const jitter = 0.5 + (options.random ?? Math.random)() * 0.5;
  return Math.min(max, Math.round(exp * jitter));
}

/**
 * Run one provider turn, retrying transient failures with exponential
 * backoff. Handlers are wrapped so we know whether anything has streamed.
 */
export async function runTurnWithRetry(
  provider: AiProvider,
  request: AiTurnRequest,
  handlers: AiTurnHandlers = {},
  options: RetryOptions = {},
): Promise<AiTurnResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const sleep = options.sleep ?? abortableSleep;
  const maxRetryAfter = options.maxRetryAfterMs ?? 90_000;

  for (let attempt = 1; ; attempt += 1) {
    let streamed = false;
    const wrapped: AiTurnHandlers = {
      ...handlers,
      onText: (delta) => {
        if (delta) streamed = true;
        handlers.onText?.(delta);
      },
      onThinking: (delta) => {
        if (delta) streamed = true;
        handlers.onThinking?.(delta);
      },
    };

    try {
      return await provider.runTurn(request, wrapped);
    } catch (error) {
      const info = classifyProviderError(error, request.signal);
      const canRetry =
        info.kind === "retryable" &&
        !streamed &&
        attempt < maxAttempts &&
        (info.retryAfterMs === undefined || info.retryAfterMs <= maxRetryAfter);
      if (!canRetry) throw error;

      const delayMs = backoffDelay(attempt, info, options);
      handlers.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        reason: info.status ? `HTTP ${info.status}: ${info.message}` : info.message,
      });
      // Rejects with AbortError if the run is cancelled mid-wait.
      await sleep(delayMs, request.signal);
    }
  }
}
