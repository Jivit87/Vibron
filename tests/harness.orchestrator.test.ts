import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunPlan } from "@/lib/agents/events";
import { orchestrate, renormalizePlan, type OrchestrationInput } from "@/lib/agents/orchestrator";
import { httpError, installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

const FILES = [
  { path: "AGENTS.md", source: "Always write tests.\n" },
  { path: "src/app.ts", source: "export const app = 1;\n" },
];

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace(FILES);
});
afterEach(() => uninstallFakeProvider());

function input(log: ReturnType<typeof eventLog>, overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
  return {
    repoKey: ws.handle.repoKey,
    handle: ws.handle,
    request: "Add a feature",
    history: [],
    mode: "auto",
    model: "claude-opus-5",
    commandPolicy: "never",
    concurrency: 1,
    emit: log.emit,
    runId: "run-1",
    ...overrides,
  };
}

const PLAN_CALL = {
  calls: [
    {
      name: "submit_plan",
      input: {
        summary: "Two steps.",
        steps: [
          { id: "api", title: "API", role: "backend", detail: "Build it", files: ["src/api.ts"] },
          { id: "ui", title: "UI", role: "frontend", detail: "Show it", files: ["src/ui.tsx"], depends_on: ["api"] },
        ],
      },
    },
  ],
};

describe("orchestrate", () => {
  it("reports loaded rules in run_start and puts them in the prompt", async () => {
    const fake = installFakeProvider([{ text: "It returns 1." }]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "ask", request: "What does app do?" }));
    const start = log.of("run_start")[0];
    expect(start).toMatchObject({ runId: "run-1", mode: "single" });
    expect(start.rules).toEqual([{ path: "AGENTS.md", tokens: expect.any(Number) }]);
    expect(fake.requests[0].system.some((b) => b.text.includes("Always write tests."))).toBe(true);
  });

  it("ask forces the read-only assistant even for a build-shaped prompt", async () => {
    installFakeProvider([
      { calls: [{ name: "write_file", input: { path: "x.ts", content: "x", summary: "s" } }] },
      { text: "I can only explain." },
    ]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "ask", request: "Build a login page" }));
    expect(log.of("agent_start")[0].role).toBe("assistant");
    expect(log.of("file_change")).toHaveLength(0);
    expect(log.of("run_done")[0]).toMatchObject({ status: "done", filesChanged: 0 });
  });

  it("plan mode plans read-only, awaits approval, and runs nothing", async () => {
    installFakeProvider([PLAN_CALL]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "plan" }));
    expect(log.of("run_start")[0].mode).toBe("plan");
    const plan = log.of("plan")[0];
    expect(plan.awaitingApproval).toBe(true);
    expect(plan.plan.steps.map((s) => s.id)).toEqual(["api", "ui"]);
    expect(log.of("agent_start")).toHaveLength(0);
    expect(log.events.at(-1)).toMatchObject({ type: "run_done", status: "done" });
  });

  it("executes an approved plan and skips dependents of a failed step", async () => {
    const approved: RunPlan = {
      summary: "Three steps.",
      steps: [
        { id: "a", title: "A", role: "backend", detail: "", files: ["src/a.ts"], dependsOn: [] },
        { id: "b", title: "B", role: "frontend", detail: "", files: ["src/b.ts"], dependsOn: ["a"] },
        { id: "c", title: "C", role: "docs", detail: "", files: ["README.md"], dependsOn: [] },
      ],
      waves: [],
    };
    // No planning turn: step A fails fatally, step C succeeds, B never runs.
    const fake = installFakeProvider([{ error: httpError(400, "bad request") }, { text: "Docs done." }]);
    const log = eventLog();
    await orchestrate(input(log, { plan: approved }));

    expect(log.of("plan")[0]).toMatchObject({ awaitingApproval: false });
    expect(fake.requests).toHaveLength(2);
    const done = new Map(log.of("agent_done").map((d) => [d.agentId, d]));
    expect(done.get("a")?.error).toBeTruthy();
    expect(done.get("b")?.error).toContain('Skipped: depends on "A"');
    expect(done.get("c")?.error).toBeUndefined();
    const runDone = log.of("run_done")[0];
    expect(runDone.status).toBe("done");
    expect(runDone.summary).toContain("skipped");
  });

  it("renormalizes an edited plan: bad roles, duplicate file claims, and waves", () => {
    const plan = renormalizePlan({
      summary: "s",
      steps: [
        { id: "x", title: "X", role: "hacker" as never, detail: "", files: ["f.ts"], dependsOn: [] },
        { id: "y", title: "Y", role: "backend", detail: "", files: ["f.ts", "g.ts"], dependsOn: ["x"] },
      ],
      waves: [["y", "x"]],
    });
    expect(plan.steps[0].role).toBe("generalist");
    expect(plan.steps[1].files).toEqual(["g.ts"]);
    expect(plan.waves).toEqual([["x"], ["y"]]);
  });

  it("marks planner tool failures as not ok", async () => {
    installFakeProvider([
      { calls: [{ id: "p1", name: "write_file", input: { path: "x", content: "", summary: "" } }] },
      PLAN_CALL,
    ]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "plan" }));
    const end = log.of("agent_tool").find((t) => t.callId === "p1" && t.phase === "end");
    expect(end?.ok).toBe(false);
  });

  it("ends a cancelled run with run_done status cancelled", async () => {
    installFakeProvider([{ hang: true }]);
    const controller = new AbortController();
    const log = eventLog();
    const pending = orchestrate(input(log, { interaction: "ask", signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    await pending;
    expect(log.of("run_done")[0]).toMatchObject({ status: "cancelled" });
  });
});
