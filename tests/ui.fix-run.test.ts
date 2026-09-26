import { describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { findIssueUrl, issuePrompt, parseCloneFrame, parseCloneInput } from "@/lib/client/clone";
import { evalTotals, normalizeEval } from "@/lib/client/eval";
import { mockScript } from "@/lib/client/mock-run";
import {
  createRun,
  evidenceOf,
  fixPhases,
  normalizeChecks,
  reduceRun,
  type RunState,
} from "@/lib/client/run-reducer";

let n = 0;
const ctx = { now: 1000, nextId: (p: string) => `${p}_${++n}` };

function fixRun(): RunState {
  return createRun({ id: "r", prompt: "p", model: "m", mode: "single", now: 0, interaction: "fix" });
}
function fold(events: OrchestrationEvent[], run = fixRun()): RunState {
  return events.reduce((r, e) => reduceRun(r, e, ctx), run);
}

const start = (agentId: string): OrchestrationEvent => ({
  type: "agent_start",
  agentId,
  stepId: agentId,
  role: "generalist",
  title: agentId,
  model: "m",
  wave: 0,
});

const verification = (
  phase: "baseline" | "gate" | "final",
  extra: Partial<Extract<OrchestrationEvent, { type: "verification" }>> = {},
): OrchestrationEvent => ({
  type: "verification",
  agentId: "a",
  phase,
  command: "pytest",
  exitCode: 1,
  timedOut: false,
  passed: 3,
  failed: 1,
  newFailures: [],
  fixed: [],
  durationMs: 10,
  excerpt: "",
  ...extra,
});

const change: OrchestrationEvent = {
  type: "file_change",
  agentId: "a",
  kind: "update",
  path: "x.py",
  before: "a",
  after: "b",
  summary: "",
  adds: 1,
  removes: 1,
};

describe("fix run reducer", () => {
  it("records verification, gate and recovery in state and in the lane feed", () => {
    const run = fold([
      start("a"),
      verification("baseline"),
      change,
      verification("gate", { newFailures: ["t_b"], fixed: ["t_a"] }),
      { type: "gate", agentId: "a", decision: "reject", reason: "regression", attempt: 1 },
      { type: "recovery", agentId: "a", failureClass: "regression", action: "hint", detail: "keep strip" },
    ]);
    expect(run.verifications).toHaveLength(2);
    expect(run.verifications[1].afterChanges).toBe(1);
    expect(run.verifications[1].checks.map((c) => c.verdict)).toEqual(["fixes", "regression"]);
    expect(run.gates[0].decision).toBe("reject");
    expect(run.recoveries[0].action).toBe("hint");
    const kinds = run.agents[0].feed.map((f) => f.kind);
    expect(kinds).toEqual(["verification", "verification", "gate", "recovery"]);
  });

  it("keeps Undo run pointed at the pre-run checkpoint, not tree snapshots", () => {
    const run = fold([
      { type: "checkpoint", id: "cp_run", label: "Before", fileCount: 3 },
      { type: "checkpoint", id: "cp_tree", label: "Batch", fileCount: 1, kind: "edit_batch", ref: "abc" },
      { type: "checkpoint", id: "cp_best", label: "Best", fileCount: 1, kind: "best" },
    ]);
    expect(run.checkpointId).toBe("cp_run");
    expect(run.checkpoints.map((c) => c.kind)).toEqual(["run", "edit_batch", "best"]);
  });

  it("numbers attempts for fix lanes and honours a declared attempt", () => {
    const run = fold([start("a"), { ...start("b") }, { ...start("c"), attempt: 5 } as OrchestrationEvent]);
    expect(run.agents.map((a) => a.attempt)).toEqual([1, 2, 5]);
    const agentRun = fold([start("a"), start("b")], createRun({ id: "r", prompt: "p", model: "m", mode: "single", now: 0 }));
    expect(agentRun.agents.map((a) => a.attempt)).toEqual([undefined, undefined]);
  });

  it("uses the gate's per-check verdicts when present and drops junk", () => {
    const checks = normalizeChecks(
      [
        { name: "a", verdict: "pre-existing", before: "fail", after: "fail" },
        { name: "b", verdict: "still_failing" },
        { verdict: "fixes" },
        { name: "c", verdict: "nonsense" },
      ],
      ["ignored"],
      [],
    );
    expect(checks.map((c) => [c.name, c.verdict])).toEqual([
      ["a", "pre_existing"],
      ["b", "still_failing"],
    ]);
  });

  it("marks the incomplete status and summarizes evidence", () => {
    const run = fold([
      start("a"),
      change,
      { type: "gate", agentId: "a", decision: "give_up", reason: "budget", attempt: 3 },
      { type: "run_done", status: "incomplete", summary: "", filesChanged: 1, durationMs: 5, costUsd: 0 },
    ]);
    expect(run.status).toBe("incomplete");
    expect(evidenceOf(run).outcome).toBe("incomplete");
    expect(fixPhases(run).find((p) => p.id === "verify")?.state).toBe("failed");
  });

  it("reports no patch when nothing changed", () => {
    const run = fold([start("a"), { type: "run_done", status: "done", summary: "", filesChanged: 0, durationMs: 5, costUsd: 0 }]);
    expect(evidenceOf(run).outcome).toBe("no_patch");
  });

  it("walks the phases through localize, edit, verify, review", () => {
    const states = (run: RunState) => fixPhases(run).map((p) => p.state);
    let run = fold([start("a")]);
    run = { ...run, status: "running" };
    expect(states(run)).toEqual(["active", "pending", "pending", "pending"]);
    run = fold([change], run);
    expect(states(run)).toEqual(["done", "active", "pending", "pending"]);
    run = fold([verification("gate", { fixed: ["t"] })], run);
    expect(states(run)).toEqual(["done", "done", "active", "pending"]);
    run = fold([{ type: "gate", agentId: "a", decision: "accept", reason: "ok", attempt: 1 }], run);
    expect(states(run)).toEqual(["done", "done", "done", "active"]);
    run = fold([{ type: "run_done", status: "done", summary: "", filesChanged: 1, durationMs: 5, costUsd: 0 }], run);
    expect(states(run)).toEqual(["done", "done", "done", "done"]);
  });

  it("folds the mock fix script: a rejection, a second attempt, then a verified accept", () => {
    const run = fold(mockScript({ prompt: "fix", interaction: "fix" }).map((s) => s.event));
    expect(run.status).toBe("done");
    expect(run.gates.map((g) => g.decision)).toEqual(["reject", "give_up", "accept"]);
    expect(run.agents.map((a) => a.attempt)).toEqual([1, 2]);
    // One agent id across attempts: attempt 1's lane is kept under an archived id.
    expect(run.agents.map((a) => a.id)).toEqual(["solver#1", "solver"]);
    expect(run.agents[0].feed.length).toBeGreaterThan(0);
    expect(run.agents[1].retryReason).toContain("No proof after 2 edits");
    expect(run.checkpointId).toBe("cp_fix");
    expect(run.localization?.snippetReproduced).toBe(true);
    expect(run.localization?.files[0]).toEqual({
      path: "textkit/slug.py",
      score: 9.4,
      why: ["in the issue traceback", "defines slugify"],
    });
    const final = run.verifications[run.verifications.length - 1];
    expect(final.checks.find((c) => c.name === "python repro_issue.py")).toMatchObject({
      verdict: "fixes",
      before: "exit 1",
      after: "pass",
    });
    const e = evidenceOf(run);
    expect(e.outcome).toBe("verified");
    expect(e.fixes).toBe(3);
    expect(e.regressions).toBe(0);
    expect(e.attempts).toBe(2);
    expect(e.rejections).toBe(1);
  });
});

describe("localize event", () => {
  const localize = (body: Record<string, unknown>) => ({ type: "localize", ...body }) as unknown as OrchestrationEvent;

  it("stores top files with reasons and the snippet result", () => {
    const run = fold([
      localize({ files: [{ path: "a.py", score: 3, why: "traceback" }, { path: "b.py", why: ["bm25", "imports a"] }, "c.py"] }),
    ]);
    expect(run.localization).toEqual({
      files: [
        { path: "a.py", score: 3, why: ["traceback"] },
        { path: "b.py", score: 0, why: ["bm25", "imports a"] },
        { path: "c.py", score: 0, why: [] },
      ],
      snippetReproduced: undefined,
    });
  });

  it("derives snippetReproduced from snippetRun.exitCode", () => {
    expect(fold([localize({ files: [], snippetRun: { code: "x", output: "", exitCode: 1 } })]).localization).toEqual({
      files: [],
      snippetReproduced: true,
    });
    expect(fold([localize({ files: ["a"], snippetRun: { exitCode: 0 } })]).localization?.snippetReproduced).toBe(false);
  });

  it("ignores a malformed or empty localize event", () => {
    expect(fold([localize({})]).localization).toBeUndefined();
    expect(fold([localize({ files: [{ nope: 1 }, 7, null] })]).localization).toBeUndefined();
  });
});

describe("check rows", () => {
  it("accepts command, original/patched objects and the `passes` verdict", () => {
    expect(
      normalizeChecks(
        [
          { command: "pytest -q", verdict: "passes", original: { passed: 4, failed: 0 }, patched: { passed: 4, failed: 0 } },
          { name: "repro", verdict: "still-failing", before: { exitCode: 1 }, after: { exitCode: 2 } },
          { command: "x", verdict: "fixes", original: false, patched: true },
        ],
        [],
        [],
      ),
    ).toEqual([
      { name: "pytest -q", verdict: "pass", before: "4 passed · 0 failed", after: "4 passed · 0 failed", excerpt: undefined },
      { name: "repro", verdict: "still_failing", before: "exit 1", after: "exit 2", excerpt: undefined },
      { name: "x", verdict: "fixes", before: "fail", after: "pass", excerpt: undefined },
    ]);
  });
});

describe("attempt 2", () => {
  const startAttempt = (attempt: number, extra: Record<string, unknown> = {}) =>
    ({ ...start("solver"), attempt, ...extra }) as OrchestrationEvent;

  it("explains the retry from the last non-accepting gate", () => {
    const run = fold([
      startAttempt(1),
      { type: "gate", agentId: "solver", decision: "reject", reason: "test_x still fails", attempt: 1 },
      startAttempt(2),
    ]);
    expect(run.agents.map((a) => [a.id, a.attempt, a.status])).toEqual([
      ["solver#1", 1, "done"],
      ["solver", 2, "running"],
    ]);
    expect(run.agents[1].retryReason).toBe("Attempt 1 ended without proof: test_x still fails");
  });

  it("prefers a reason sent on agent_start, and falls back without any ruling", () => {
    expect(fold([startAttempt(1), startAttempt(2, { reason: "Budget hit." })]).agents[1].retryReason).toBe("Budget hit.");
    expect(fold([startAttempt(1), startAttempt(2)]).agents[1].retryReason).toBe("Attempt 1 ended without proof.");
  });

  it("does not archive when the same attempt restarts", () => {
    const run = fold([startAttempt(1), startAttempt(1)]);
    expect(run.agents.map((a) => a.id)).toEqual(["solver"]);
    expect(run.agents[0].retryReason).toBeUndefined();
  });
});

describe("clone input", () => {
  it("recognises repos, slugs, ssh and issue URLs", () => {
    expect(parseCloneInput("vercel/next.js")).toMatchObject({ kind: "repo", label: "vercel/next.js" });
    expect(parseCloneInput("https://github.com/acme/textkit.git")).toMatchObject({ kind: "repo", label: "acme/textkit" });
    expect(parseCloneInput("git@github.com:acme/textkit.git")).toMatchObject({ kind: "repo", label: "acme/textkit" });
    expect(parseCloneInput("https://github.com/acme/textkit/issues/412")).toMatchObject({ kind: "issue", number: 412 });
    expect(parseCloneInput("not a url")).toBeNull();
    expect(parseCloneInput("")).toBeNull();
  });

  it("finds an issue URL in free text and builds the fix prompt", () => {
    expect(findIssueUrl("see https://github.com/a/b/issues/7 please")).toBe("https://github.com/a/b/issues/7");
    expect(findIssueUrl("https://github.com/a/b")).toBeNull();
    const prompt = issuePrompt({ title: "Bug", body: "Steps", url: "u" }, "only py");
    expect(prompt).toContain("Fix this issue: Bug");
    expect(prompt).toContain("Steps");
    expect(prompt).toContain("Notes: only py");
  });

  it("parses clone SSE frames", () => {
    expect(parseCloneFrame('data: {"type":"progress","text":"hi"}')).toEqual({ type: "progress", text: "hi" });
    expect(parseCloneFrame("data: nope")).toBeNull();
    expect(parseCloneFrame(": keepalive")).toBeNull();
  });
});

describe("eval table", () => {
  it("normalizes flat rows and SolveResult-shaped rows", () => {
    const table = normalizeEval({
      results: [
        { task: "a", resolved: true, gate: "accept", tokens: 100, durationMs: 1000 },
        { taskId: "b", status: "incomplete", gate: { decision: "give_up" }, metrics: { inputTokens: 50, outputTokens: 5, durationMs: 200 } },
        { nothing: true },
      ],
    });
    expect(table.rows).toEqual([
      { task: "a", category: undefined, resolved: true, status: "resolved", gate: "accept", tokens: 100, durationMs: 1000 },
      { task: "b", category: undefined, resolved: false, status: "incomplete", gate: "give_up", tokens: 55, durationMs: 200 },
    ]);
    expect(evalTotals(table.rows)).toMatchObject({ count: 2, resolved: 1, rate: 0.5, tokens: 155, durationMs: 1200 });
    expect(normalizeEval([{ id: "x", status: "resolved" }]).rows[0].resolved).toBe(true);
  });
});
