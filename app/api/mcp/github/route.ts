/**
 * The GitHub MCP integration.
 *
 *   GET    /api/mcp/github?repoKey=…[&connect=1] → configuration + status
 *   PUT    /api/mcp/github { mode, token?, useGhCli?, toolsets, readOnly, trusted, host?, repoKey? }
 *   DELETE /api/mcp/github?repoKey=…
 *
 * Stored as the user-global MCP server "github", so every workspace gets it
 * and a project `.mcp.json` can still shadow it. The token never comes back
 * to the browser — only a masked fingerprint.
 */

import { parseServerEntry } from "@/lib/mcp/config";
import {
  apiBaseForHost,
  buildGithubEntry,
  GITHUB_MODES,
  GITHUB_SERVER_NAME,
  maskToken,
  normalizeToolsets,
  readGhCliToken,
  readGithubEntry,
  verifyGithubToken,
  type GithubMode,
} from "@/lib/mcp/github";
import { connectionSnapshot, disconnectServer, restartServer } from "@/lib/mcp/manager";
import { getGlobalEntries, resolveServers, setGlobalEntry } from "@/lib/mcp/settings";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

async function workspace(repoKey: string): Promise<{ scope: string; rootPath: string | null }> {
  if (!repoKey) return { scope: "", rootPath: null };
  const handle = await openWorkspace(repoKey).catch(() => null);
  return { scope: repoKey, rootPath: handle?.rootPath ?? null };
}

async function status(repoKey: string, connect: boolean) {
  const { scope, rootPath } = await workspace(repoKey);
  const summary = readGithubEntry((await getGlobalEntries())[GITHUB_SERVER_NAME]);
  if (!summary) return { configured: false };

  // A project file may define its own "github", which wins over this one.
  const resolved = await resolveServers(scope, rootPath);
  const effective = resolved.servers.find((s) => s.name === GITHUB_SERVER_NAME);
  const shadowedBy = effective && effective.source !== "global" ? effective.source : null;

  if (connect && effective && effective.enabled && !shadowedBy) {
    await restartServer(scope, effective, rootPath);
  }
  const snap = connectionSnapshot(scope, GITHUB_SERVER_NAME);
  return {
    configured: true,
    mode: summary.mode,
    maskedToken: maskToken(summary.token),
    toolsets: summary.toolsets,
    readOnly: summary.readOnly,
    trusted: summary.trusted,
    enabled: summary.enabled,
    host: summary.host ?? "",
    shadowedBy,
    status: summary.enabled ? snap.status : "disabled",
    error: snap.error,
    toolCount: snap.tools.length,
    serverInfo: snap.serverInfo,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return Response.json(await status(url.searchParams.get("repoKey") ?? "", url.searchParams.get("connect") === "1"));
}

interface PutBody {
  mode?: unknown;
  token?: unknown;
  useGhCli?: unknown;
  toolsets?: unknown;
  readOnly?: unknown;
  trusted?: unknown;
  enabled?: unknown;
  host?: unknown;
  repoKey?: unknown;
}

export async function PUT(request: Request) {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return bad("Body must be valid JSON");
  }

  const mode = GITHUB_MODES.includes(body.mode as GithubMode) ? (body.mode as GithubMode) : "remote";
  const host = mode === "remote" ? "" : typeof body.host === "string" ? body.host.trim() : "";
  const existing = readGithubEntry((await getGlobalEntries())[GITHUB_SERVER_NAME]);

  let token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token && body.useGhCli === true) {
    token = (await readGhCliToken()) ?? "";
    if (!token) return bad("The GitHub CLI is not installed or not logged in. Run `gh auth login` first.");
  }
  // Changing only options keeps the stored token.
  if (!token) token = existing?.token ?? "";
  if (!token) return bad("A GitHub token is required.");
  if (/\s/.test(token)) return bad("That does not look like a token (it contains whitespace).");

  let apiBase: string;
  try {
    apiBase = apiBaseForHost(host);
  } catch {
    return bad("Host must be a hostname or URL, e.g. https://github.example.com");
  }
  const check = await verifyGithubToken(token, apiBase);
  if (!check.ok) return bad(check.error ?? "Token verification failed.");

  const entry = {
    ...buildGithubEntry({
      mode,
      token,
      toolsets: normalizeToolsets(body.toolsets, mode),
      readOnly: body.readOnly === true,
      trusted: body.trusted === true,
      host,
    }),
    ...(body.enabled === false ? { disabled: true } : {}),
  };
  const parsed = parseServerEntry(GITHUB_SERVER_NAME, entry, "global");
  if (typeof parsed === "string") return bad(parsed);
  await setGlobalEntry(GITHUB_SERVER_NAME, entry);

  // Pooled connections for other workspaces notice the new fingerprint on
  // their next run; reconnect this one now so the UI reports real status.
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  return Response.json({
    ok: true,
    login: check.login,
    scopes: check.scopes,
    ...(await status(repoKey, body.enabled !== false)),
  });
}

export async function DELETE(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  await setGlobalEntry(GITHUB_SERVER_NAME, null);
  await disconnectServer(repoKey, GITHUB_SERVER_NAME, true);
  return Response.json({ ok: true });
}
