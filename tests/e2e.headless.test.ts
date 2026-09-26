/**
 * End-to-end headless run with an injected fake solver: exercises the real
 * workspace registration, graph index, verification detection/run, the
 * evidence bundle, exit codes, worktree mode, run memory and the eval
 * pipeline — everything except the model loop (EXEC-A's solveTask).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { runEval } from "@/eval/run";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { emptySolveResult, runHeadless } from "@/lib/headless/run";
import { clearMemoryGraphCache, getMemoryGraph } from "@/lib/memory/graph";
import { resetMemoryStoreForTests } from "@/lib/store";
import { runVerification, which } from "@/lib/verify";
import { writeFile as wsWriteFile } from "@/lib/workspace";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const BUGGY = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
const FIXED = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

async function jsRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-e2e-"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "m", scripts: { test: "node --test" } }));
  await writeFile(path.join(root, "math.js"), BUGGY);
  await writeFile(
    path.join(root, "test", "math.test.js"),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../math');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\ntest('zero', () => assert.strictEqual(add(0, 0), 0));\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, env: gitEnv });
  return root;
}

/** A stand-in for solveTask: baseline → edit → final verification → diff. */
function fakeSolve(fix: string | null, status?: SolveResult["status"]) {
  const calls: SolveOptions[] = [];
  const solve = async (options: SolveOptions): Promise<SolveResult> => {
    calls.push(options);
    const root = options.handle.rootPath!;
    const cmd = options.verify.commands[0]!;
    options.emit({ type: "run_start" } as never);
    const baseline = await runVerification(root, cmd, { timeoutMs: 60_000 });
    if (fix) await wsWriteFile(options.handle, "math.js", fix);
    const final = await runVerification(root, cmd, { timeoutMs: 60_000 });
    const diff = execFileSync("git", ["diff"], { cwd: root }).toString();
    const result = emptySolveResult(status ?? (final.exitCode === 0 ? "resolved" : "failed"));
    return {
      ...result,
      summary: "add() subtracted instead of adding.",
      diff,
      filesChanged: fix ? ["math.js"] : [],
      gate: {
        ...result.gate,
        enabled: true,
        command: cmd.command,
        baseline,
        final,
        fixed: Object.keys(final.tests).filter((t) => final.tests[t] === "pass" && baseline.tests[t] !== "pass"),
        ranAfterLastEdit: true,
        reason: "verified",
      },
      metrics: { ...result.metrics, modelCalls: 3, toolCalls: 5, inputTokens: 1000, outputTokens: 200, verifyRuns: 2 },
    };
  };
  return { solve, calls };
}

describe("headless run", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    clearMemoryGraphCache();
  });

  it("resolved run writes result.json, trajectory.jsonl, patch.diff, report.md and exits 0", async () => {
    const repo = await jsRepo();
    const { solve, calls } = fakeSolve(FIXED);
    const outcome = await runHeadless({ repo, task: "add() returns the wrong result", taskId: "t1", maxTurns: 7 }, { solve });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.outDir).toBe(path.join(repo, ".viberon", "runs", "t1"));
    expect(calls[0]!.verify).toMatchObject({ enabled: true, baseline: true });
    expect(calls[0]!.verify.commands[0]).toMatchObject({ command: "npm test", framework: "node-test" });
    expect(calls[0]!.budget.maxTurns).toBe(7);
    expect(calls[0]!.useRepoRules).toBe(false);

    const result = JSON.parse(readFileSync(path.join(outcome.outDir, "result.json"), "utf8"));
    expect(result).toMatchObject({ schemaVersion: 1, taskId: "t1", exitCode: 0, status: "resolved", filesChanged: ["math.js"] });
    expect(result.gate.baseline.counts.failed).toBe(1);
    expect(result.gate.final.counts).toMatchObject({ passed: 2, failed: 0 });

    const lines = readFileSync(path.join(outcome.outDir, "trajectory.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "meta", taskId: "t1", schemaVersion: 1 });
    expect(lines.slice(1, -1).every((l) => l.type === "event")).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", events: 1 });

    const patch = readFileSync(path.join(outcome.outDir, "patch.diff"), "utf8");
    expect(patch).toContain("+  return a + b;");
    const report = readFileSync(path.join(outcome.outDir, "report.md"), "utf8");
    expect(report).toContain("VERIFIED FIX");
    expect(report).toContain("| npm test | 1 passed, 1 failed");
    expect(report).toContain("```diff");

    // Evidence and memory live in .viberon/, which never enters the diff.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    expect(status.trim()).toBe("M math.js");
    const memory = getMemoryGraph(repo);
    expect(memory.runs[0]).toMatchObject({ issue: "add() returns the wrong result", verified: true, filesChanged: ["math.js"] });
  });

  it("maps statuses to exit codes: incomplete → 1, thrown error → 2", async () => {
    const repo = await jsRepo();
    const incomplete = await runHeadless(
      { repo, task: "x", taskId: "t2" },
      { solve: fakeSolve(null, "incomplete").solve },
    );
    expect(incomplete.exitCode).toBe(1);
    const crashed = await runHeadless(
      { repo, task: "x", taskId: "t3" },
      { solve: async () => Promise.reject(new Error("model unavailable")) },
    );
    expect(crashed.exitCode).toBe(2);
    expect(crashed.result).toMatchObject({ status: "error", error: "model unavailable" });
    const noTask = await runHeadless({ repo, taskId: "t4" }, { solve: fakeSolve(FIXED).solve });
    expect(noTask.exitCode).toBe(2);
  });

  it("--worktree leaves the original checkout untouched and removes the worktree", async () => {
    const repo = await jsRepo();
    const { solve, calls } = fakeSolve(FIXED);
    const outcome = await runHeadless({ repo, task: "fix add", taskId: "wt", worktree: true, testCmd: "node --test" }, { solve });
    expect(outcome.exitCode).toBe(0);
    const workRoot = calls[0]!.handle.rootPath!;
    expect(workRoot).not.toBe(repo);
    expect(calls[0]!.verify.commands).toEqual([
      { command: "node --test", framework: "custom", kind: "test", source: "--test-cmd" },
    ]);
    expect(readFileSync(path.join(repo, "math.js"), "utf8")).toBe(BUGGY);
    expect(existsSync(workRoot)).toBe(false);
    expect(outcome.result.diff).toContain("+  return a + b;");
    // The patch applies cleanly to the original.
    execFileSync("git", ["apply", "--check", path.join(outcome.outDir, "patch.diff")], { cwd: repo });
  });

  it.runIf(which("python3") !== null || which("python") !== null)(
    "eval pipeline: prepares tasks, runs headless, grades hidden tests, writes results",
    async () => {
      const resultsDir = await mkdtemp(path.join(os.tmpdir(), "viberon-evalres-"));
      const solve = async (options: SolveOptions): Promise<SolveResult> => {
        const root = options.handle.rootPath!;
        if (existsSync(path.join(root, "src", "truncate.js"))) {
          await wsWriteFile(
            options.handle,
            "src/truncate.js",
            '"use strict";\nfunction truncate(text, max, { ellipsis = "..." } = {}) {\n  if (text.length <= max) return text;\n  const cut = text.slice(0, Math.max(0, max - ellipsis.length));\n  const lastSpace = cut.lastIndexOf(" ");\n  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + ellipsis;\n}\nmodule.exports = { truncate };\n',
          );
        }
        // inventory-stacktrace is left unfixed: hidden tests must fail it.
        return { ...emptySolveResult("resolved"), diff: execFileSync("git", ["diff"], { cwd: root }).toString() };
      };
      const summary = await runEval({
        only: ["truncate-regression", "inventory-stacktrace"],
        solve,
        resultsDir,
        venv: false,
        log: () => {},
      });
      expect(summary).toMatchObject({ total: 2, resolved: 1, honestVerdicts: 1 });
      const report = JSON.parse(readFileSync(path.join(resultsDir, "latest.json"), "utf8"));
      expect(report.rows.map((r: { task: string; resolved: boolean }) => [r.task, r.resolved])).toEqual([
        ["inventory-stacktrace", false],
        ["truncate-regression", true],
      ]);
      expect(readFileSync(path.join(resultsDir, "results.md"), "utf8")).toContain("Resolved 1/2");
      expect(existsSync(path.join(resultsDir, "runs", "truncate-regression", "report.md"))).toBe(true);
    },
    120_000,
  );
});
