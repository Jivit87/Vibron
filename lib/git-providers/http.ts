/**
 * The one REST helper the GitLab and Bitbucket adapters share: JSON in and
 * out, a 30 s timeout, and failures turned into `GitProviderError` with a
 * hint that says what to fix. Error text never includes request headers, so
 * it cannot carry a token.
 */

import { GitProviderError, PLATFORM_LABEL, type GitPlatform } from "@/lib/git-providers/interface";

export interface RestRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Return the response text instead of parsing JSON. */
  raw?: boolean;
}

function errorDetail(platform: GitPlatform, text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (platform === "bitbucket") {
      const error = parsed.error as { message?: string; detail?: unknown } | undefined;
      if (error?.message) return `${error.message}${typeof error.detail === "string" ? ` (${error.detail})` : ""}`;
    }
    const message = parsed.message ?? parsed.error_description ?? parsed.error;
    if (typeof message === "string") return message;
    if (message && typeof message === "object") return JSON.stringify(message);
  } catch {
    // not JSON
  }
  return text;
}

export async function restCall<T>(
  platform: GitPlatform,
  req: RestRequest,
  ctx: { fetchImpl?: typeof fetch; signal?: AbortSignal; authenticated: boolean; describe: string },
): Promise<T> {
  const headers = { ...req.headers };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await (ctx.fetchImpl ?? fetch)(req.url, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: ctx.signal ?? AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  if (!response.ok) {
    const label = PLATFORM_LABEL[platform];
    const detail = errorDetail(platform, await response.text().catch(() => ""));
    const hint =
      response.status === 401
        ? ` Check the ${label} credentials in Settings → Integrations.`
        : response.status === 429
          ? ` ${label}'s rate limit is used up; wait for it to reset.`
          : response.status === 403 || response.status === 404
            ? ctx.authenticated
              ? " The credentials may lack access to this repository."
              : ` Add ${label} credentials in Settings → Integrations for private repositories.`
            : "";
    const shown = detail.slice(0, 300).trim();
    const stop = hint && shown && !/[.!?]$/.test(shown) ? "." : "";
    throw new GitProviderError(
      `${label} ${req.method} ${ctx.describe} → ${response.status}: ${shown}${stop}${hint}`,
      response.status,
      platform,
    );
  }
  const text = await response.text();
  if (req.raw) return text as T;
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A path segment or file path for a URL: each segment percent-encoded. */
export function encodePath(value: string): string {
  return value.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}
