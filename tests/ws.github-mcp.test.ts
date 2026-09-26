import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseServerEntry } from "@/lib/mcp/config";
import {
  apiBaseForHost,
  buildGithubEntry,
  DEFAULT_GITHUB_TOOLSETS,
  GITHUB_DOCKER_IMAGE,
  GITHUB_REMOTE_URL,
  maskToken,
  normalizeToolsets,
  readGithubEntry,
  verifyGithubToken,
  type GithubOptions,
} from "@/lib/mcp/github";
import { getGlobalEntries } from "@/lib/mcp/settings";
import { resetMemoryStoreForTests } from "@/lib/store";

const base: GithubOptions = {
  mode: "remote",
  token: "ghp_abcdefghijklmnop1234",
  toolsets: ["repos", "issues"],
  readOnly: false,
  trusted: false,
};

beforeEach(() => resetMemoryStoreForTests());

describe("GitHub MCP entry", () => {
  it("remote mode is an HTTP entry with bearer auth and toolset headers", () => {
    const entry = buildGithubEntry({ ...base, readOnly: true });
    expect(entry).toMatchObject({
      type: "http",
      url: GITHUB_REMOTE_URL,
      headers: {
        Authorization: `Bearer ${base.token}`,
        "X-MCP-Toolsets": "repos,issues",
        "X-MCP-Readonly": "true",
      },
    });
    const parsed = parseServerEntry("github", entry, "global");
    expect(typeof parsed).not.toBe("string");
    expect(parsed).toMatchObject({ transport: { type: "http", url: GITHUB_REMOTE_URL } });
  });

  it("docker mode forwards env by name so the token is not in argv", () => {
    const entry = buildGithubEntry({ ...base, mode: "docker", host: "https://ghe.example.com" });
    expect(entry.command).toBe("docker");
    expect(entry.args?.at(-1)).toBe(GITHUB_DOCKER_IMAGE);
    expect(entry.args?.join(" ")).not.toContain(base.token);
    expect(entry.args).toEqual(expect.arrayContaining(["-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_HOST"]));
    expect(entry.env).toMatchObject({
      GITHUB_PERSONAL_ACCESS_TOKEN: base.token,
      GITHUB_TOOLSETS: "repos,issues",
      GITHUB_HOST: "https://ghe.example.com",
    });
  });

  it("binary mode runs `github-mcp-server stdio`", () => {
    const entry = buildGithubEntry({ ...base, mode: "binary", readOnly: true });
    expect(entry).toMatchObject({ command: "github-mcp-server", args: ["stdio"], env: { GITHUB_READ_ONLY: "1" } });
  });

  it.each(["remote", "docker", "binary"] as const)("%s round-trips through readGithubEntry", (mode) => {
    const options = { ...base, mode, readOnly: true, trusted: true };
    expect(readGithubEntry(buildGithubEntry(options))).toMatchObject({
      mode,
      token: base.token,
      toolsets: ["repos", "issues"],
      readOnly: true,
      trusted: true,
      enabled: true,
    });
  });

  it("drops unknown and remote-only toolsets, falls back to defaults", () => {
    expect(normalizeToolsets(["issues", "bogus", "repos", "repos"], "remote")).toEqual(["repos", "issues"]);
    expect(normalizeToolsets(["copilot_spaces"], "docker")).toEqual(DEFAULT_GITHUB_TOOLSETS);
    expect(normalizeToolsets(["copilot_spaces"], "remote")).toEqual(["copilot_spaces"]);
    expect(normalizeToolsets(undefined, "remote")).toEqual(DEFAULT_GITHUB_TOOLSETS);
  });

  it("masks tokens to prefix and last four", () => {
    expect(maskToken("github_pat_11AAAAAA_xyzw9876")).toBe("github_pat_••••9876");
    expect(maskToken("ghp_abcdefghijklmnop1234")).toBe("ghp_••••1234");
  });

  it("maps hosts to REST bases", () => {
    expect(apiBaseForHost("")).toBe("https://api.github.com");
    expect(apiBaseForHost("octo.ghe.com")).toBe("https://api.octo.ghe.com");
    expect(apiBaseForHost("https://github.example.com")).toBe("https://github.example.com/api/v3");
  });
});

describe("verifyGithubToken", () => {
  it("reports login and classic scopes", async () => {
    const fake = vi.fn(async () =>
      new Response(JSON.stringify({ login: "octocat" }), { headers: { "x-oauth-scopes": "repo, read:org" } }),
    );
    await expect(verifyGithubToken("t", undefined, fake as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
      login: "octocat",
      scopes: ["repo", "read:org"],
    });
  });

  it("rejects a 401", async () => {
    const fake = vi.fn(async () => new Response("", { status: 401 }));
    const result = await verifyGithubToken("t", undefined, fake as unknown as typeof fetch);
    expect(result.ok).toBe(false);
  });
});

describe("/api/mcp/github", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores a verified token, never returns it, and keeps it on option-only updates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ login: "octocat" }))),
    );
    const { PUT, GET, DELETE } = await import("@/app/api/mcp/github/route");
    const put = (body: unknown) =>
      PUT(new Request("http://x/api/mcp/github", { method: "PUT", body: JSON.stringify(body) }));

    // enabled:false keeps the test from connecting to the real server.
    const first = await put({ mode: "remote", token: base.token, toolsets: ["repos"], enabled: false });
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    expect(firstBody).not.toContain(base.token);
    expect(JSON.parse(firstBody)).toMatchObject({ login: "octocat", maskedToken: "ghp_••••1234" });

    const second = await put({ mode: "docker", toolsets: ["issues"], readOnly: true, enabled: false });
    expect(second.status).toBe(200);
    const stored = readGithubEntry((await getGlobalEntries()).github);
    expect(stored).toMatchObject({ mode: "docker", token: base.token, toolsets: ["issues"], readOnly: true, enabled: false });

    const status = await (await GET(new Request("http://x/api/mcp/github"))).json();
    expect(status).toMatchObject({ configured: true, mode: "docker", status: "disabled" });

    await DELETE(new Request("http://x/api/mcp/github", { method: "DELETE" }));
    expect((await getGlobalEntries()).github).toBeUndefined();
  });

  it("refuses a token GitHub rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const { PUT } = await import("@/app/api/mcp/github/route");
    const response = await PUT(
      new Request("http://x/api/mcp/github", { method: "PUT", body: JSON.stringify({ token: "bad" }) }),
    );
    expect(response.status).toBe(400);
    expect((await getGlobalEntries()).github).toBeUndefined();
  });
});
