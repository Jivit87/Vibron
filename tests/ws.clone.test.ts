import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as issueGet } from "@/app/api/issue/route";
import { fetchGitHubIssue } from "@/lib/github";
import { buildGithubEntry } from "@/lib/mcp/github";
import { setGlobalEntry } from "@/lib/mcp/settings";
import { resetMemoryStoreForTests } from "@/lib/store";
import { gitAuthEnv, resolveGithubToken } from "@/lib/workspace/clone";

const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

async function storeToken(token: string) {
  await setGlobalEntry(
    "github",
    buildGithubEntry({ mode: "remote", token, toolsets: [], readOnly: true, trusted: false }),
  );
}

function issueFetch(seen: { url: string; auth?: string }[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), auth: headers.Authorization });
    return Response.json({ title: "Private bug", body: "details", html_url: "https://github.com/acme/secret/issues/3" });
  }) as typeof fetch;
}

describe("GitHub token for clones and issues", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers the stored integration token, then GITHUB_TOKEN, else anonymous", async () => {
    expect(await resolveGithubToken()).toBeNull();
    process.env.GITHUB_TOKEN = "env-token";
    expect(await resolveGithubToken()).toBe("env-token");
    await storeToken("stored-token");
    expect(await resolveGithubToken()).toBe("stored-token");
  });

  it("passes the token to git through GIT_CONFIG_* env, only for github.com https", () => {
    const env = gitAuthEnv("tok", "https://github.com/acme/secret.git");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("AUTHORIZATION: basic ", ""), "base64").toString()).toBe(
      "x-access-token:tok",
    );
    expect(gitAuthEnv("tok", "https://gitlab.com/acme/secret.git")).toEqual({});
    expect(gitAuthEnv("tok", "git@github.com:acme/secret.git")).toEqual({});
    expect(gitAuthEnv(null, "https://github.com/acme/secret.git")).toEqual({});
  });

  it("GET /api/issue authenticates with the stored token (no network: fetch is injected)", async () => {
    await storeToken("stored-token");
    const seen: { url: string; auth?: string }[] = [];
    vi.stubGlobal("fetch", issueFetch(seen));
    const response = await issueGet(new Request(`http://x/api/issue?url=${encodeURIComponent("https://github.com/acme/secret/issues/3")}`));
    expect(await response.json()).toEqual({ title: "Private bug", body: "details", url: "https://github.com/acme/secret/issues/3" });
    expect(seen).toEqual([{ url: "https://api.github.com/repos/acme/secret/issues/3", auth: "Bearer stored-token" }]);
  });

  it("fetchGitHubIssue is anonymous when no token is available", async () => {
    const seen: { url: string; auth?: string }[] = [];
    await fetchGitHubIssue("https://github.com/acme/pub/issues/1", issueFetch(seen), null);
    expect(seen[0]!.auth).toBeUndefined();
  });
});
