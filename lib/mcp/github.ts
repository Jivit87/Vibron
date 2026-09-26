/**
 * GitHub's official MCP server (github/github-mcp-server) as a built-in
 * integration.
 *
 * The server itself is a Go program, so Viberon does not embed it. It
 * connects to it one of three ways, all configured from one settings row:
 *
 *   remote — GitHub's hosted endpoint over streamable HTTP. Nothing to
 *            install; the token travels as a bearer header.
 *   docker — `ghcr.io/github/github-mcp-server` over stdio.
 *   binary — a locally built `github-mcp-server stdio`.
 *
 * The result is an ordinary user-global server entry named "github", so
 * pooling, approvals, role filtering and tool naming (`mcp__github__…`) all
 * come from the generic MCP layer. The token is stored in that entry (the
 * settings store is server-side and the MCP route redacts it), never in
 * process.env.
 *
 * Everything except `verifyGithubToken` and `readGhCliToken` is pure.
 */

import { execFile } from "node:child_process";

import type { RawServerEntry } from "@/lib/mcp/config";
import { DEFAULT_GITHUB_TOOLSETS, GITHUB_TOOLSETS, type GithubMode } from "@/lib/mcp/github-toolsets";

export const GITHUB_SERVER_NAME = "github";
export const GITHUB_REMOTE_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_DOCKER_IMAGE = "ghcr.io/github/github-mcp-server";
export const GITHUB_BINARY = "github-mcp-server";

export { DEFAULT_GITHUB_TOOLSETS, GITHUB_MODES, GITHUB_TOOLSETS, type GithubMode } from "@/lib/mcp/github-toolsets";

const KNOWN_TOOLSETS = new Set(GITHUB_TOOLSETS.map((t) => t.id));

export interface GithubOptions {
  mode: GithubMode;
  token: string;
  toolsets: string[];
  readOnly: boolean;
  trusted: boolean;
  /** GitHub Enterprise Server / ghe.com host. Local modes only. */
  host?: string;
}

/** Drop unknowns and duplicates, keep upstream order. Empty → defaults. */
export function normalizeToolsets(toolsets: unknown, mode: GithubMode): string[] {
  const wanted = new Set(
    Array.isArray(toolsets) ? toolsets.filter((t): t is string => typeof t === "string") : [],
  );
  const picked = GITHUB_TOOLSETS.filter(
    (t) => wanted.has(t.id) && KNOWN_TOOLSETS.has(t.id) && !(t.remoteOnly && mode !== "remote"),
  ).map((t) => t.id);
  return picked.length > 0 ? picked : [...DEFAULT_GITHUB_TOOLSETS];
}

/** Build the server entry stored under `GITHUB_SERVER_NAME`. */
export function buildGithubEntry(options: GithubOptions): RawServerEntry {
  const toolsets = normalizeToolsets(options.toolsets, options.mode).join(",");
  const host = options.host?.trim();

  if (options.mode === "remote") {
    return {
      type: "http",
      url: GITHUB_REMOTE_URL,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "X-MCP-Toolsets": toolsets,
        ...(options.readOnly ? { "X-MCP-Readonly": "true" } : {}),
      },
      trusted: options.trusted,
    };
  }

  const env: Record<string, string> = {
    GITHUB_PERSONAL_ACCESS_TOKEN: options.token,
    GITHUB_TOOLSETS: toolsets,
    ...(options.readOnly ? { GITHUB_READ_ONLY: "1" } : {}),
    ...(host ? { GITHUB_HOST: host } : {}),
  };

  if (options.mode === "docker") {
    // `-e NAME` without a value forwards the variable from the docker CLI's
    // own environment, which is where the stdio transport puts `env`. The
    // token therefore never appears in the process list.
    const args = ["run", "-i", "--rm"];
    for (const name of Object.keys(env)) args.push("-e", name);
    args.push(GITHUB_DOCKER_IMAGE);
    return { command: "docker", args, env, trusted: options.trusted };
  }

  return { command: GITHUB_BINARY, args: ["stdio"], env, trusted: options.trusted };
}

/** What the settings UI needs to show about a stored entry. */
export interface GithubEntrySummary {
  mode: GithubMode;
  token: string;
  toolsets: string[];
  readOnly: boolean;
  trusted: boolean;
  enabled: boolean;
  host?: string;
}

/** Inverse of `buildGithubEntry`, tolerant of hand edits. */
export function readGithubEntry(entry: RawServerEntry | undefined | null): GithubEntrySummary | null {
  if (!entry) return null;
  const base = { trusted: entry.trusted === true, enabled: entry.disabled !== true };

  if (typeof entry.url === "string") {
    const headers = entry.headers ?? {};
    const auth = headers.Authorization ?? headers.authorization ?? "";
    return {
      ...base,
      mode: "remote",
      token: auth.replace(/^Bearer\s+/i, ""),
      toolsets: splitList(headers["X-MCP-Toolsets"]),
      readOnly: isTruthy(headers["X-MCP-Readonly"]),
    };
  }

  const env = entry.env ?? {};
  return {
    ...base,
    mode: entry.command === "docker" ? "docker" : "binary",
    token: env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "",
    toolsets: splitList(env.GITHUB_TOOLSETS),
    readOnly: isTruthy(env.GITHUB_READ_ONLY),
    ...(env.GITHUB_HOST ? { host: env.GITHUB_HOST } : {}),
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes)$/i.test(value.trim());
}

/** The same fingerprint style as provider keys: prefix and last four. */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.startsWith("${")) return token;
  const prefix = token.match(/^(github_pat_|gh[pousr]_)/)?.[0] ?? "";
  return `${prefix}••••${token.slice(-4)}`;
}

/* ------------------------------- network ---------------------------------- */

export interface TokenCheck {
  ok: boolean;
  login?: string;
  /** Classic PATs report scopes; fine-grained tokens report none. */
  scopes?: string[];
  error?: string;
}

/**
 * Confirm a token works before storing it, so a typo surfaces here rather
 * than as a 401 halfway through an agent run.
 */
export async function verifyGithubToken(
  token: string,
  apiBase = "https://api.github.com",
  fetchImpl: typeof fetch = fetch,
): Promise<TokenCheck> {
  try {
    const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "viberon",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { ok: false, error: "GitHub rejected that token (401)." };
    if (!response.ok) return { ok: false, error: `GitHub returned ${response.status}.` };
    const body = (await response.json()) as { login?: string };
    const scopes = response.headers.get("x-oauth-scopes");
    return {
      ok: true,
      login: body.login,
      ...(scopes !== null ? { scopes: splitList(scopes) } : {}),
    };
  } catch (error) {
    return { ok: false, error: `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The REST base for a GHES / ghe.com host, for token verification. */
export function apiBaseForHost(host: string | undefined): string {
  const h = host?.trim();
  if (!h) return "https://api.github.com";
  const url = new URL(h.includes("://") ? h : `https://${h}`);
  if (url.hostname === "github.com") return "https://api.github.com";
  if (url.hostname.endsWith(".ghe.com")) return `https://api.${url.hostname}`;
  return `${url.origin}/api/v3`;
}

/** The token the GitHub CLI is logged in with, if it is installed. */
export function readGhCliToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5_000 }, (error, stdout) => {
      const token = String(stdout ?? "").trim();
      resolve(error || !token ? null : token);
    });
  });
}
