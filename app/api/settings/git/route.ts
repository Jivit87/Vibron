/**
 * GitLab and Bitbucket credentials (the GitHub token lives in /api/mcp/github).
 *
 *   GET    /api/settings/git → { gitlab: {configured, masked, baseUrl, fromEnv},
 *                                bitbucket: {configured, masked, mode, username, fromEnv} }
 *   PUT    /api/settings/git { platform: "gitlab", token?, baseUrl?, skipVerify? }
 *          /api/settings/git { platform: "bitbucket", mode: "basic", username, appPassword?, skipVerify? }
 *          /api/settings/git { platform: "bitbucket", mode: "bearer", token?, skipVerify? }
 *   DELETE /api/settings/git?platform=gitlab|bitbucket
 *
 * Secrets never come back to the browser, only masked fingerprints. An
 * empty secret on PUT keeps the stored one (so the GitLab URL can change
 * alone). Saving verifies the credentials with one live request first.
 */

import type { BitbucketAuth } from "@/lib/git-providers/bitbucket";
import {
  GITLAB_DEFAULT_URL,
  getStoredBitbucket,
  getStoredGitLab,
  gitCredentialStatus,
  setStoredBitbucket,
  setStoredGitLab,
} from "@/lib/git-providers/credentials";
import { normalizeBaseUrl } from "@/lib/git-providers/detect";
import { verifyBitbucket, verifyGitLabToken } from "@/lib/git-providers/verify";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => Response.json({ error }, { status });
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const looksLikeSecret = (value: string) => !/\s/.test(value);

/** https only; plain http just for a GitLab on this machine. */
function gitlabBase(raw: string): string | null {
  const base = normalizeBaseUrl(raw || GITLAB_DEFAULT_URL);
  if (!base) return null;
  const url = new URL(base);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return base;
}

export async function GET() {
  return Response.json(await gitCredentialStatus());
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("Body must be valid JSON");
  }
  const skipVerify = body.skipVerify === true;

  if (body.platform === "gitlab") {
    const baseUrl = gitlabBase(text(body.baseUrl));
    if (!baseUrl) return bad("GitLab URL must be an https URL, e.g. https://gitlab.example.com");
    const stored = await getStoredGitLab();
    // A stored token is only reused for the instance it was entered for.
    const sameInstance = (normalizeBaseUrl(stored?.baseUrl ?? "") ?? GITLAB_DEFAULT_URL) === baseUrl;
    if (!text(body.token) && stored && !sameInstance) return bad("Enter the token again for a different GitLab URL.");
    const token = text(body.token) || stored?.token || "";
    if (!token) return bad("A GitLab access token is required.");
    if (!looksLikeSecret(token)) return bad("That does not look like a token (it contains whitespace).");
    let login: string | undefined;
    if (!skipVerify) {
      const check = await verifyGitLabToken(token, baseUrl);
      if (!check.ok) return bad(check.error ?? "Token verification failed.");
      login = check.login;
    }
    await setStoredGitLab({ token, ...(baseUrl === GITLAB_DEFAULT_URL ? {} : { baseUrl }) });
    return Response.json({ ok: true, login, ...(await gitCredentialStatus()) });
  }

  if (body.platform === "bitbucket") {
    const stored = await getStoredBitbucket();
    let auth: BitbucketAuth;
    if (body.mode === "bearer") {
      const token = text(body.token) || (stored?.mode === "bearer" ? stored.token : "");
      if (!token) return bad("A Bitbucket access token is required.");
      if (!looksLikeSecret(token)) return bad("That does not look like a token (it contains whitespace).");
      auth = { kind: "bearer", token };
    } else if (body.mode === "basic") {
      const username = text(body.username);
      if (!username || /[\s:]/.test(username)) return bad("A Bitbucket username (no spaces or colons) is required.");
      const password = text(body.appPassword) || (stored?.mode === "basic" && stored.username === username ? stored.appPassword : "");
      if (!password) return bad("A Bitbucket app password is required.");
      if (!looksLikeSecret(password)) return bad("That does not look like an app password (it contains whitespace).");
      auth = { kind: "basic", username, password };
    } else {
      return bad('mode must be "basic" (username + app password) or "bearer" (access token).');
    }
    let login: string | undefined;
    if (!skipVerify) {
      const check = await verifyBitbucket(auth);
      if (!check.ok) return bad(check.error ?? "Credential verification failed.");
      login = check.login;
    }
    await setStoredBitbucket(
      auth.kind === "basic" ? { mode: "basic", username: auth.username, appPassword: auth.password } : { mode: "bearer", token: auth.token },
    );
    return Response.json({ ok: true, login, ...(await gitCredentialStatus()) });
  }

  return bad('platform must be "gitlab" or "bitbucket".');
}

export async function DELETE(request: Request) {
  const platform = new URL(request.url).searchParams.get("platform");
  if (platform === "gitlab") await setStoredGitLab(null);
  else if (platform === "bitbucket") await setStoredBitbucket(null);
  else return bad('platform must be "gitlab" or "bitbucket".');
  return Response.json({ ok: true, ...(await gitCredentialStatus()) });
}
