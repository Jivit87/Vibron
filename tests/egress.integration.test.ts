/**
 * Egress enforcement wired through the real entry points: the agent's
 * run_command and browse tools, the settings API routes, and MCP connects.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getLog } from "@/app/api/settings/egress/log/route";
import { GET, POST, PUT } from "@/app/api/settings/egress/route";
import { readAudit } from "@/lib/egress/audit";
import { DEFAULT_EGRESS_POLICY, type EgressPolicy } from "@/lib/egress/policy";
import { setGlobalPolicy } from "@/lib/egress/settings";
import type { ApprovalAsk } from "@/lib/harness/runs";
import { parseServerEntry, type McpServerConfig } from "@/lib/mcp/config";
import { disconnectServer, ensureConnected } from "@/lib/mcp/manager";
import { runTool, type ToolContext } from "@/lib/tools/registry";
import { makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

let ws: TestWorkspace;
let root: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    handle: { ...ws.handle, rootPath: root },
    engine: ws.engine,
    memory: ws.memory,
    agent: "Test",
    commandPolicy: "auto",
    events: {},
    ...overrides,
  };
}

const policy = (patch: Partial<EgressPolicy>): EgressPolicy => ({ ...DEFAULT_EGRESS_POLICY, ...patch });

beforeEach(async () => {
  ws = await makeWorkspace([{ path: "a.ts", source: "export const a = 1;\n" }], "egress-ws");
  root = await mkdtemp(path.join(os.tmpdir(), "egress-int-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("run_command", () => {
  it("deny mode refuses a network command before it runs, and logs it", async () => {
    await setGlobalPolicy(policy({ mode: "deny" }));
    const out = await runTool("run_command", { command: "curl https://example.com/install.sh -o i.sh" }, ctx());
    expect(out).toMatch(/^Refused by the network egress policy: curl: network egress is disabled/);
    const log = await readAudit(root);
    expect(log[0]).toMatchObject({ host: "example.com", decision: "deny", source: "terminal", rule: "mode:deny" });
    expect(log[0].command).toContain("curl https://example.com");
  });

  it("allowlist: an off-list host forces an approval even under Auto", async () => {
    await setGlobalPolicy(policy({ mode: "allowlist", presets: ["packageRegistries"] }));
    const asks: ApprovalAsk[] = [];
    const requestApproval = vi.fn(async (ask: ApprovalAsk) => {
      asks.push(ask);
      return false;
    });
    const out = await runTool("run_command", { command: "wget https://random.example/tool.tgz" }, ctx({ events: { requestApproval } }));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(asks[0].reason).toContain("random.example");
    expect(out).toMatch(/^The user declined/);
    const log = await readAudit(root);
    expect(log[0]).toMatchObject({ host: "random.example", decision: "deny" });
    expect(log[0].rule).toContain("declined by user");
  });

  it("allowlist: with no one to approve, off-list commands are refused", async () => {
    await setGlobalPolicy(policy({ mode: "allowlist", presets: [] }));
    const out = await runTool("run_command", { command: "git clone https://gitlab.example/o/r.git" }, ctx());
    expect(out).toMatch(/no one is available to approve it/);
  });

  it("an approved command runs with the egress proxy in its environment", async () => {
    await setGlobalPolicy(policy({ mode: "allowlist", presets: [] }));
    const requestApproval = vi.fn(async () => true);
    const out = await runTool(
      "run_command",
      { command: `curl --version https://random.example/ >/dev/null; echo "proxy=$HTTPS_PROXY"` },
      ctx({ events: { requestApproval } }),
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/proxy=http:\/\/viberon:[0-9a-f]+@127\.0\.0\.1:\d+/);
    const log = await readAudit(root);
    expect(log.find((e) => e.host === "random.example")?.rule).toContain("approved by user");
  });

  it("allowed hosts and non-network commands are unaffected", async () => {
    await setGlobalPolicy(policy({ mode: "allowlist", presets: ["packageRegistries"] }));
    const requestApproval = vi.fn(async () => true);
    const out = await runTool("run_command", { command: "echo hello" }, ctx({ events: { requestApproval } }));
    expect(out).toContain("hello");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("compare refuses denied network commands too", async () => {
    await setGlobalPolicy(policy({ rules: [{ action: "deny", pattern: "evil.test" }] }));
    const compare = vi.fn(async () => "ran");
    const out = await runTool("compare", { command: "curl https://evil.test" }, ctx({ harness: { compare } }));
    expect(out).toMatch(/^Refused by the network egress policy/);
    expect(compare).not.toHaveBeenCalled();
  });
});

describe("browse tool", () => {
  it("is held to the policy", async () => {
    await setGlobalPolicy(policy({ mode: "deny" }));
    const out = await runTool("browse", { url: "https://developer.mozilla.org/" }, ctx());
    expect(out).toContain("Blocked by the network egress policy");
    expect((await readAudit(root))[0]).toMatchObject({ source: "browse", decision: "deny" });
  });

  it("refuses the metadata service in open mode", async () => {
    const out = await runTool("browse", { url: "http://169.254.169.254/latest/meta-data/" }, ctx());
    expect(out).toContain("cloud metadata address");
  });
});

describe("MCP remote servers", () => {
  it("a denied remote server fails to connect with the policy reason", async () => {
    await setGlobalPolicy(policy({ rules: [{ action: "deny", pattern: "*.evil.test" }] }));
    const config = parseServerEntry("remote", { url: "https://mcp.evil.test/mcp" }, "global") as McpServerConfig;
    const conn = await ensureConnected("egress-ws", { ...config, enabled: true }, root);
    expect(conn.status).toBe("error");
    expect(conn.error).toContain("blocked by the network egress policy");
    expect((await readAudit(root))[0]).toMatchObject({ host: "mcp.evil.test", source: "mcp", decision: "deny" });
    await disconnectServer("egress-ws", "remote", true);
  });
});

describe("settings API", () => {
  const json = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("round-trips global and workspace policies with validation", async () => {
    const badRes = await PUT(new Request("http://x/api/settings/egress", json({ scope: "global", policy: { mode: "strict" } })));
    expect(badRes.status).toBe(400);

    const ok = await PUT(
      new Request("http://x/api/settings/egress", json({ scope: "global", policy: { mode: "allowlist", presets: ["docs"], rules: [{ action: "deny", pattern: "evil.test" }] } })),
    );
    expect(ok.status).toBe(200);

    const noKey = await PUT(new Request("http://x/api/settings/egress", json({ scope: "workspace", policy: { mode: "deny" } })));
    expect(noKey.status).toBe(400);

    const wsRes = await PUT(new Request("http://x/api/settings/egress", json({ scope: "workspace", repoKey: "egress-ws", policy: { mode: "deny", rules: [] } })));
    expect(wsRes.status).toBe(200);

    const snap = (await (await GET(new Request("http://x/api/settings/egress?repoKey=egress-ws"))).json()) as {
      global: EgressPolicy;
      effective: { mode: string; modeFrom: string; rules: { pattern: string; origin: string }[] };
      sandbox: { network: string };
      presets: unknown[];
    };
    expect(snap.global.mode).toBe("allowlist");
    expect(snap.effective).toMatchObject({ mode: "deny", modeFrom: "workspace" });
    expect(snap.effective.rules).toEqual([expect.objectContaining({ pattern: "evil.test", origin: "global" })]);
    expect(snap.sandbox.network).toBe("none");
    expect(snap.presets.length).toBe(4);

    const cleared = await PUT(new Request("http://x/api/settings/egress", json({ scope: "workspace", repoKey: "egress-ws", policy: null })));
    const after = (await cleared.json()) as { effective: { mode: string } };
    expect(after.effective.mode).toBe("allowlist");
  });

  it("dry-runs commands and URLs without logging", async () => {
    await setGlobalPolicy(policy({ mode: "allowlist", presets: ["packageRegistries"] }));
    const post = (body: unknown) => POST(new Request("http://x/api/settings/egress", { method: "POST", body: JSON.stringify(body) }));
    const cmd = (await (await post({ action: "test", repoKey: "egress-ws", command: "npm install && curl https://x.example" })).json()) as {
      action: string;
      findings: { target: string; action: string }[];
    };
    expect(cmd.action).toBe("ask");
    expect(cmd.findings.map((f) => f.action)).toEqual(["allow", "ask"]);
    const url = (await (await post({ action: "test", url: "169.254.169.254" })).json()) as { allowed: boolean };
    expect(url.allowed).toBe(false);
    expect((await post({ action: "nope" })).status).toBe(400);
  });

  it("the log route validates filters", async () => {
    expect((await getLog(new Request("http://x/api/settings/egress/log?decision=maybe"))).status).toBe(400);
    const res = await getLog(new Request("http://x/api/settings/egress/log?limit=5"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toBeInstanceOf(Array);
  });
});

describe("CLI --egress", () => {
  it("parses on commands that run agents, installs or clones", async () => {
    const { parseCliArgs, CliError } = await import("@/cli/viberon");
    expect(parseCliArgs(["run", "--repo", ".", "--task", "x", "--egress", "deny"])).toMatchObject({ command: "run", egress: "deny" });
    expect(parseCliArgs(["clone", "o/r", "--egress", "allowlist"])).toMatchObject({ command: "clone", egress: "allowlist" });
    expect(parseCliArgs(["run", "--repo", ".", "--task", "x"])).not.toHaveProperty("egress");
    expect(() => parseCliArgs(["run", "--repo", ".", "--task", "x", "--egress", "strict"])).toThrow(CliError);
    expect(() => parseCliArgs(["review", "--egress", "deny"])).toThrow(/Unknown option for review: --egress/);
  });
});
