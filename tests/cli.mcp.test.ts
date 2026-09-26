import { beforeEach, describe, expect, it } from "vitest";

import { parseMcpArgs, runMcp, type McpArgs, type McpIo } from "@/cli/mcp";
import { CliError, parseCliArgs } from "@/cli/viberon";
import { getMcpSecret } from "@/lib/ai/credentials";
import { clearRegistryCache } from "@/lib/mcp/catalog";
import { getGlobalEntries } from "@/lib/mcp/settings";
import { resetMemoryStoreForTests } from "@/lib/store";

function io(env: Record<string, string> = {}, answers?: string[]): McpIo & { stdout: string; stderr: string; asked: [string, boolean][] } {
  const state = {
    stdout: "",
    stderr: "",
    asked: [] as [string, boolean][],
    env,
    out: (t: string) => {
      state.stdout += t;
    },
    err: (t: string) => {
      state.stderr += t;
    },
    ...(answers
      ? {
          ask: async (q: string, secret: boolean) => {
            state.asked.push([q, secret]);
            return answers.shift() ?? "";
          },
        }
      : {}),
  };
  return state;
}

const args = (argv: string[]) => parseMcpArgs(argv) as McpArgs;

beforeEach(() => {
  resetMemoryStoreForTests();
  clearRegistryCache();
  delete process.env.VIBERON_MCP_REGISTRY_URL;
});

describe("parseMcpArgs", () => {
  it("parses every action", () => {
    expect(parseMcpArgs(["list", "--installed", "--json"])).toMatchObject({ action: "list", installed: true, json: true });
    expect(parseMcpArgs(["search", "web", "search", "--category", "search"])).toMatchObject({ target: "web search", category: "search" });
    expect(parseMcpArgs(["install", "slack", "--set", "SLACK_TEAM_ID=T1", "--set=A=b=c", "-y"])).toMatchObject({
      action: "install",
      target: "slack",
      set: { SLACK_TEAM_ID: "T1", A: "b=c" },
      yes: true,
    });
    expect(parseMcpArgs(["test", "git", "--timeout", "5", "--repo", "/r"])).toMatchObject({ timeoutSec: 5, repo: "/r" });
    expect(parseMcpArgs(["remove", "git"])).toMatchObject({ action: "remove", target: "git" });
    expect(parseMcpArgs([])).toEqual({ command: "help" });
  });

  it("rejects bad input", () => {
    expect(() => parseMcpArgs(["frobnicate"])).toThrow(/Unknown mcp action/);
    expect(() => parseMcpArgs(["install"])).toThrow(/exactly one server id/);
    expect(() => parseMcpArgs(["search"])).toThrow(/query is required/);
    expect(() => parseMcpArgs(["list", "--category", "nope"])).toThrow(/--category/);
    expect(() => parseMcpArgs(["install", "x", "--set", "novalue"])).toThrow(/NAME=value/);
    expect(() => parseMcpArgs(["test", "x", "--set", "A=b"])).toThrow(/only for mcp install/);
    expect(() => parseMcpArgs(["list", "--bogus"])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(["mcp", "nope"])).toThrow(CliError);
    expect(parseCliArgs(["mcp", "list"])).toMatchObject({ command: "mcp", action: "list" });
  });
});

describe("runMcp", () => {
  it("lists and searches the catalog", async () => {
    const a = io();
    expect(await runMcp(args(["list"]), a)).toBe(0);
    expect(a.stdout).toMatch(/^filesystem/m);
    expect(a.stdout).toMatch(/^context7/m);

    const b = io();
    expect(await runMcp(args(["search", "postgres", "--json"]), b)).toBe(0);
    const parsed = JSON.parse(b.stdout) as { entries: { id: string }[] };
    expect(parsed.entries[0]!.id).toBe("postgres");
  });

  it("refuses to install non-interactively without --yes, and installs with it", async () => {
    const env = { BRAVE_API_KEY: "BSA-from-the-environment-123" };
    const a = io(env);
    expect(await runMcp(args(["install", "brave-search"]), a)).toBe(2);
    expect(a.stderr).toMatch(/runs:\s+npx -y @brave\/brave-search-mcp-server --transport stdio/);
    expect(a.stderr).toMatch(/re-run with --yes/);
    expect(await getGlobalEntries()).toEqual({});

    const b = io(env);
    expect(await runMcp(args(["install", "brave-search", "--yes", "--json"]), b)).toBe(0);
    expect(b.stdout + b.stderr).not.toContain("BSA-from-the-environment");
    expect(await getMcpSecret("brave-search", "BRAVE_API_KEY")).toBe(env.BRAVE_API_KEY);
    expect(JSON.stringify(await getGlobalEntries())).not.toContain("BSA-from");

    const c = io();
    expect(await runMcp(args(["list", "--installed"]), c)).toBe(0);
    expect(c.stdout.trim().split("\n")).toHaveLength(1);
    expect(c.stdout).toMatch(/installed/);
  });

  it("prompts for missing values (secrets hidden) and for confirmation", async () => {
    const a = io({}, ["xoxb-typed-token", "T999", "y"]);
    expect(await runMcp(args(["install", "slack"]), a)).toBe(0);
    expect(a.asked.map(([, secret]) => secret)).toEqual([true, false, false]);
    expect((await getGlobalEntries()).slack!.env).toEqual({ SLACK_BOT_TOKEN: "${secret:SLACK_BOT_TOKEN}", SLACK_TEAM_ID: "T999" });

    const declined = io({}, ["n"]);
    expect(await runMcp(args(["install", "time"]), declined)).toBe(1);
    expect((await getGlobalEntries()).time).toBeUndefined();
  });

  it("reports missing required values", async () => {
    const a = io();
    expect(await runMcp(args(["install", "postgres", "--yes"]), a)).toBe(2);
    expect(a.stderr).toMatch(/missing DATABASE_URL/);
  });

  it("enables, disables and removes", async () => {
    await runMcp(args(["install", "fetch", "--yes"]), io());
    expect(await runMcp(args(["disable", "fetch"]), io())).toBe(0);
    expect((await getGlobalEntries()).fetch!.disabled).toBe(true);
    expect(await runMcp(args(["enable", "fetch"]), io())).toBe(0);
    expect(await runMcp(args(["remove", "fetch"]), io())).toBe(0);
    expect(await getGlobalEntries()).toEqual({});
    const a = io();
    expect(await runMcp(args(["remove", "fetch"]), a)).toBe(2);
    expect(a.stderr).toMatch(/not installed from the marketplace/);
  });

  it("warns and falls back when the registry is unreachable", async () => {
    const a = io();
    expect(await runMcp(args(["list", "--registry", "http://insecure.example.com/r.json"]), a)).toBe(0);
    expect(a.stderr).toMatch(/registry unavailable .*https.*bundled catalog/);
    expect(a.stdout).toMatch(/^filesystem/m);
  });
});
