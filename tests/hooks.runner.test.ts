import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/hooks/route";
import { hooksCommand } from "@/cli/hooks";
import { parseCliArgs } from "@/cli/viberon";
import { MAX_STOP_HOOK_BLOCKS, runAgent, type AgentRunInput, type RunController } from "@/lib/agents/runner";
import { hashHooksFile } from "@/lib/hooks/config";
import { clearHookStateForTests, HookEngine } from "@/lib/hooks/engine";
import { trustStateFor } from "@/lib/hooks/trust";
import type { HookInput, HookResult, InProcessHook } from "@/lib/hooks/types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { solveTask } from "@/lib/harness/solve";
import { openWorkspace, readFile } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

interface HooksBody {
  error?: string;
  activeCount: number;
  workspace: { exists: boolean; trust: string; hash: string; hooks: { event: string; command: string }[] };
}

const FILES = [{ path: "src/app.ts", source: "export function app() {\n  return 1;\n}\n" }];

let ws: TestWorkspace;

function engineWith(...hooks: InProcessHook[]): HookEngine {
  return new HookEngine({ builtins: hooks, cwd: null, repoKey: ws.handle.repoKey, runId: "run" });
}

/** The engine reports to the run's sink, as the orchestrator and solveTask wire it. */
function engineFor(log: ReturnType<typeof eventLog>, ...hooks: InProcessHook[]): HookEngine {
  return new HookEngine({ builtins: hooks, cwd: null, repoKey: ws.handle.repoKey, runId: "run", emit: log.emit });
}

function input(log: ReturnType<typeof eventLog>, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentId: "solo",
    stepId: "solo",
    role: "generalist",
    model: "claude-opus-5",
    task: "Change app to return 2.",
    files: [],
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    commandPolicy: "never",
    emit: log.emit,
    mcp: false,
    ...overrides,
  };
}

const EDIT = { id: "c1", name: "edit_file", input: { path: "src/app.ts", find: "return 1", replace: "return 2", summary: "bump" } };

/** The content of the tool_result the model received in request `i`. */
function toolResult(fake: ReturnType<typeof installFakeProvider>, i: number): string {
  const block = fake.requests[i]!.messages.at(-1)!.content.find((b) => b.type === "tool_result") as { content: string };
  return block.content;
}

function lastUserText(fake: ReturnType<typeof installFakeProvider>, i: number): string {
  const block = fake.requests[i]!.messages.at(-1)!.content.find((b) => b.type === "text") as { text: string };
  return block.text;
}

beforeEach(async () => {
  clearHookStateForTests();
  ws = await makeWorkspace(FILES);
});
afterEach(() => {
  uninstallFakeProvider();
  clearHookStateForTests();
});

describe("runner: PreToolUse / PostToolUse", () => {
  it("a deny never runs the tool and its reason reaches the model as the tool result", async () => {
    const fake = installFakeProvider([{ calls: [EDIT] }, { text: "Understood." }]);
    const log = eventLog();
    const hooks = engineFor(log, {
      name: "freeze-src",
      event: "PreToolUse",
      matcher: "edit_file|write_file",
      run: () => ({ decision: "deny", reason: "src/ is frozen during the release." }),
    });
    await runAgent(input(log, { hooks }));

    expect(await readFile(ws.handle, "src/app.ts")).toContain("return 1");
    const result = toolResult(fake, 1);
    expect(result).toBe("Refused by a PreToolUse hook: src/ is frozen during the release.");
    // Marked as an error result so the model treats it as a refusal.
    const block = fake.requests[1]!.messages.at(-1)!.content[0] as { is_error?: boolean };
    expect(block.is_error).toBe(true);
    expect(log.of("hook")[0]).toMatchObject({ agentId: "solo", event: "pre_tool", tool: "edit_file", blocked: true, source: "builtin" });
    expect(log.of("agent_tool").at(-1)).toMatchObject({ phase: "end", ok: false });
  });

  it("a modified input is what actually runs (and still goes through the tool's own checks)", async () => {
    const fake = installFakeProvider([{ calls: [EDIT] }, { text: "done" }]);
    const hooks = engineWith({
      name: "rewrite",
      event: "PreToolUse",
      matcher: "edit_file",
      run: (payload: HookInput): HookResult => ({ updatedInput: { ...payload.tool_input, replace: "return 42" } }),
    });
    await runAgent(input(eventLog(), { hooks }));
    expect(await readFile(ws.handle, "src/app.ts")).toContain("return 42");
    expect(toolResult(fake, 1)).toContain("A PreToolUse hook modified this call's input");

    // A rewrite onto a path outside the write scope is still refused by the tool.
    ws = await makeWorkspace(FILES);
    installFakeProvider([{ calls: [EDIT] }, { text: "done" }]);
    const escape = engineWith({
      name: "escape",
      event: "PreToolUse",
      run: (payload) => ({ updatedInput: { ...payload.tool_input, path: "other/file.ts" } }),
    });
    await runAgent(input(eventLog(), { hooks: escape, files: ["src/app.ts"] }));
    expect(await readFile(ws.handle, "other/file.ts")).toBeNull();
  });

  it("PostToolUse feedback is appended to the tool result", async () => {
    const fake = installFakeProvider([{ calls: [EDIT] }, { text: "done" }]);
    const seen: HookInput[] = [];
    const hooks = engineWith({
      name: "lint",
      event: "PostToolUse",
      matcher: "edit_file",
      run: (payload) => {
        seen.push(payload);
        return { additionalContext: "eslint: src/app.ts:2 prefer-const" };
      },
    });
    await runAgent(input(eventLog(), { hooks }));
    const result = toolResult(fake, 1);
    expect(result).toMatch(/\[hook feedback\]\neslint: src\/app.ts:2 prefer-const$/);
    expect(seen[0]).toMatchObject({ tool_name: "edit_file", tool_failed: false, tool_input: { path: "src/app.ts" } });
    expect(seen[0]!.tool_response).toBeTruthy();
  });

  it("PostToolUse does not fire for calls a PreToolUse hook denied", async () => {
    installFakeProvider([{ calls: [EDIT] }, { text: "ok" }]);
    const post = vi.fn(() => null);
    const hooks = engineWith(
      { name: "deny", event: "PreToolUse", run: () => ({ decision: "deny", reason: "no" }) },
      { name: "post", event: "PostToolUse", run: post },
    );
    await runAgent(input(eventLog(), { hooks }));
    expect(post).not.toHaveBeenCalled();
  });
});

describe("runner: Stop hooks and the gate", () => {
  it("a Stop hook can send the agent back to work, with its reason", async () => {
    const fake = installFakeProvider([{ text: "All done." }, { text: "Now really done." }]);
    let calls = 0;
    const hooks = engineWith({
      name: "needs-changelog",
      event: "Stop",
      run: (payload) => {
        calls += 1;
        return payload.stop_hook_active ? null : { decision: "deny", reason: "Update CHANGELOG.md first." };
      },
    });
    const result = await runAgent(input(eventLog(), { hooks }));
    expect(calls).toBe(2);
    expect(lastUserText(fake, 1)).toContain("Update CHANGELOG.md first.");
    expect(result.summary).toBe("Now really done.");
    expect(result.stopReason).toBe("finished");
  });

  it("an always-blocking Stop hook cannot spin the loop forever", async () => {
    installFakeProvider(Array.from({ length: MAX_STOP_HOOK_BLOCKS + 2 }, (_, i) => ({ text: `try ${i}` })));
    const hooks = engineWith({ name: "never", event: "Stop", run: () => ({ decision: "deny", reason: "no" }) });
    const result = await runAgent(input(eventLog(), { hooks }));
    expect(result.stopReason).toBe("finished");
    expect(result.summary).toBe(`try ${MAX_STOP_HOOK_BLOCKS}`);
  });

  it("never overrides a gate rejection: the gate's feedback stands and the agent keeps working", async () => {
    const fake = installFakeProvider([{ text: "I'm done." }, { text: "Fixed for real." }]);
    let rejections = 0;
    const controller: RunController = {
      onFinishAttempt: async () => (rejections++ === 0 ? { feedback: "GATE: 2 tests still fail." } : null),
    };
    const stop = vi.fn(() => ({ decision: "allow" as const }));
    const hooks = engineWith({ name: "approve-everything", event: "Stop", run: stop });
    const result = await runAgent(input(eventLog(), { hooks, controller }));
    // The rejection went to the model even though the Stop hook would approve.
    expect(lastUserText(fake, 1)).toBe("GATE: 2 tests still fail.");
    // The hook was consulted only once the gate let the agent end.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("Fixed for real.");
  });

  it("is never consulted after the controller has accepted the work", async () => {
    installFakeProvider([{ text: "done" }]);
    const stop = vi.fn(() => ({ decision: "deny" as const, reason: "reopen" }));
    const controller: RunController = { onFinishAttempt: async () => null, isDone: () => true };
    const result = await runAgent(input(eventLog(), { hooks: engineWith({ name: "s", event: "Stop", run: stop }), controller }));
    expect(stop).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("finished");
  });

  it("holds back `finish` before the gate runs; an allowed finish is still ruled on by the gate", async () => {
    const finishCall = { name: "finish", input: { summary: "fixed", reproduction: "npm test" } };
    const fake = installFakeProvider([{ calls: [finishCall] }, { calls: [finishCall] }, { text: "wrapped up" }]);
    const gate = vi.fn(async () => "GATE REJECT: regression in test_a");
    let blocked = false;
    const hooks = engineWith({
      name: "one-more-check",
      event: "Stop",
      run: (payload) => {
        expect(payload.last_message).toBe("fixed");
        if (blocked) return { decision: "allow" };
        blocked = true;
        return { decision: "deny", reason: "Run the linter before finishing." };
      },
    });
    await runAgent(input(eventLog(), { role: "solver", hooks, harness: { finish: gate } }));
    // First finish: the hook objected, so the gate never ran.
    expect(toolResult(fake, 1)).toContain("Finish blocked by a Stop hook (the verification gate did not run)");
    expect(toolResult(fake, 1)).toContain("Run the linter before finishing.");
    // Second finish: the hook allowed it, and the gate's rejection is what the model got.
    expect(gate).toHaveBeenCalledTimes(1);
    expect(toolResult(fake, 2)).toBe("GATE REJECT: regression in test_a");
  });
});

describe("API route and CLI", () => {
  let root: string;
  let configDir: string;
  let repoKey: string;

  beforeEach(async () => {
    resetMemoryStoreForTests();
    root = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-api-"));
    configDir = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-home-"));
    vi.stubEnv("VIBERON_CONFIG_DIR", configDir);
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    mkdirSync(path.join(root, ".viberon"));
    writeFileSync(path.join(root, ".viberon", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ command: "npm test" }] } }));
    repoKey = (await registerLocalWorkspace(root)).repoKey;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const post = async (body: unknown) => {
    const res = await POST(new Request("http://localhost/api/hooks", { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as HooksBody };
  };

  it("GET shows the workspace file as untrusted; POST trust needs the hash that was shown", async () => {
    const res = await GET(new Request(`http://localhost/api/hooks?repoKey=${encodeURIComponent(repoKey)}`));
    const body = (await res.json()) as HooksBody;
    expect(body.workspace).toMatchObject({ exists: true, trust: "untrusted", hooks: [{ event: "Stop", command: "npm test" }] });
    expect(body.activeCount).toBe(0);

    expect((await post({ action: "trust", repoKey, hash: "0".repeat(64) })).status).toBe(409);
    expect(await trustStateFor(root, body.workspace.hash)).toBe("untrusted");

    const ok = await post({ action: "trust", repoKey, hash: body.workspace.hash });
    expect(ok.status).toBe(200);
    expect(ok.json.workspace.trust).toBe("trusted");
    expect(ok.json.activeCount).toBe(1);

    const revoked = await post({ action: "revoke", repoKey });
    expect(revoked.json.workspace.trust).toBe("untrusted");
    expect((await post({ action: "nope", repoKey })).status).toBe(400);
    expect((await post({ action: "trust", repoKey: "missing" })).status).toBe(400);
  });

  it("parses `viberon hooks` arguments", () => {
    expect(parseCliArgs(["hooks"])).toEqual({ command: "hooks", action: "list", repo: ".", yes: false, json: false });
    expect(parseCliArgs(["hooks", "trust", "--repo", "/r", "--yes"])).toMatchObject({ action: "trust", repo: "/r", yes: true });
    expect(parseCliArgs(["hooks", "list", "/r", "--json"])).toMatchObject({ action: "list", repo: "/r", json: true });
    expect(() => parseCliArgs(["hooks", "delete"])).toThrow(/unknown action/);
    expect(() => parseCliArgs(["hooks", "list", "--yes"])).toThrow(/only apply to trust/);
    expect(() => parseCliArgs(["hooks", "trust", "--hash", "abc"])).toThrow(/sha256/);
  });

  it("`viberon hooks trust` shows the commands, asks, and records trust", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    const args = { command: "hooks" as const, action: "trust" as const, repo: root, yes: false, json: false };

    // No terminal and no --yes: refuse.
    expect(await hooksCommand(args, io)).toBe(2);
    expect(err.join("")).toMatch(/--yes/);

    // Declined at the prompt.
    expect(await hooksCommand(args, { ...io, confirm: async () => false })).toBe(1);

    const hash = hashHooksFile(JSON.stringify({ hooks: { Stop: [{ command: "npm test" }] } }));
    expect(await hooksCommand({ ...args, yes: true, hash: "f".repeat(64) }, io)).toBe(2);
    expect(await hooksCommand({ ...args, yes: true, hash }, io)).toBe(0);
    expect(out.join("")).toContain("Stop  npm test");
    expect(await trustStateFor(root, hash)).toBe("trusted");

    out.length = 0;
    expect(await hooksCommand({ ...args, action: "list" }, io)).toBe(0);
    expect(out.join("")).toMatch(/Workspace .* trusted/);
    expect(await hooksCommand({ ...args, action: "revoke" }, io)).toBe(0);
    expect(await trustStateFor(root, hash)).toBe("untrusted");
  });
});

describe("solveTask: SessionStart and UserPromptSubmit", () => {
  let root: string;
  beforeEach(() => {
    resetMemoryStoreForTests();
    root = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-solve-"));
    writeFileSync(path.join(root, "lib.js"), "exports.a = 1;\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function solve(hooks: HookEngine) {
    const meta = await registerLocalWorkspace(root);
    const log = eventLog();
    const result = await solveTask({
      handle: await openWorkspace(meta.repoKey),
      task: "Make a equal 2.",
      model: "claude-opus-5",
      emit: log.emit,
      runId: "solve-1",
      budget: { maxTurns: 4 },
      verify: { enabled: false, commands: [], timeoutMs: 10_000, baseline: false },
      maxAttempts: 1,
      hooks,
    });
    return { result, log };
  }

  it("a UserPromptSubmit deny stops the task before any model call", async () => {
    const fake = installFakeProvider([{ text: "should not run" }]);
    const hooks = new HookEngine({
      builtins: [{ name: "policy", event: "UserPromptSubmit", run: () => ({ decision: "deny", reason: "tasks need a ticket id" }) }],
      cwd: root,
      repoKey: "k",
      runId: "solve-1",
    });
    const { result } = await solve(hooks);
    expect(result.status).toBe("error");
    expect(result.error).toContain("tasks need a ticket id");
    expect(fake.requests).toHaveLength(0);
  });

  it("SessionStart context is handed to the solver with the task", async () => {
    const fake = installFakeProvider([{ text: "Nothing to change." }, { text: "Still nothing." }]);
    const hooks = new HookEngine({
      builtins: [{ name: "ctx", event: "SessionStart", run: (p) => ({ additionalContext: `source=${p.source}; deploy freeze until Friday` }) }],
      cwd: root,
      repoKey: "k",
      runId: "solve-1",
    });
    await solve(hooks);
    const first = fake.requests[0]!.messages[0]!.content.find((b) => b.type === "text") as { text: string };
    expect(first.text).toContain("<hook_context>\nsource=solve; deploy freeze until Friday\n</hook_context>");
  });
});
