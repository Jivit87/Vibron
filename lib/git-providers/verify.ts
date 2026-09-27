/**
 * Check GitLab / Bitbucket credentials with one live request before they are
 * stored, so a typo surfaces in Settings rather than as a 401 halfway
 * through a delivery. Mirrors `verifyGithubToken` in lib/mcp/github.ts.
 */

import { BITBUCKET_API, type BitbucketAuth } from "@/lib/git-providers/bitbucket";

export interface CredentialCheck {
  ok: boolean;
  /** The account the credentials act as, when the host says. */
  login?: string;
  error?: string;
}

export async function verifyGitLabToken(token: string, baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<CredentialCheck> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/v4/user`, {
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json", "User-Agent": "Viberon" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { ok: false, error: "GitLab rejected that token (401)." };
    if (response.status === 403) return { ok: false, error: "GitLab accepted the token but it lacks the api / read_user scope (403)." };
    if (!response.ok) return { ok: false, error: `GitLab returned ${response.status}.` };
    const body = (await response.json().catch(() => ({}))) as { username?: string };
    return { ok: true, ...(body.username ? { login: body.username } : {}) };
  } catch (error) {
    return { ok: false, error: `Could not reach GitLab at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Basic auth (username + app password) must read `/user`. An access token
 * belongs to a repository, project or workspace rather than a user, so for
 * a bearer token a 403 on `/user` still proves the token is valid.
 */
export async function verifyBitbucket(auth: BitbucketAuth, fetchImpl: typeof fetch = fetch): Promise<CredentialCheck> {
  const authorization =
    auth.kind === "basic"
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`
      : `Bearer ${auth.token}`;
  try {
    const response = await fetchImpl(`${BITBUCKET_API}/user`, {
      headers: { Authorization: authorization, Accept: "application/json", "User-Agent": "Viberon" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { ok: false, error: "Bitbucket rejected those credentials (401)." };
    if (response.status === 403 && auth.kind === "bearer") return { ok: true };
    if (!response.ok) return { ok: false, error: `Bitbucket returned ${response.status}.` };
    const body = (await response.json().catch(() => ({}))) as { username?: string; nickname?: string };
    const login = body.username ?? body.nickname;
    return { ok: true, ...(login ? { login } : {}) };
  } catch (error) {
    return { ok: false, error: `Could not reach Bitbucket: ${error instanceof Error ? error.message : String(error)}` };
  }
}
