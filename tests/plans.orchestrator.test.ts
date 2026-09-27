/**
 * Plan versioning through the real orchestrator (scripted provider): every
 * plan it shows or runs becomes a version, runs append outcomes, edits
 * branch off their parent, and a version can be re-run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunPlan } from "@/lib/agents/events";
import { orchestrate, type OrchestrationInput } from "@/lib/agents/orchestrator";
import { createPlanRecorder } from "@/lib/plans/recorder";
import { PlanStore } from "@/lib/plans/store";
import { rerunInput } from "@/lib/plans";
import { httpError, installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

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

let ws: TestWorkspace;
let dir: string;
let store: PlanStore;
beforeEach(async () => {
  ws = await makeWorkspace([{ path: "src/app.ts", source: "export const app = 1;\n" }]);
  dir = mkdtempSync(path.join(os.tmpdir(), "viberon-plan-orch-"));
  store = new PlanStore(dir);
});
afterEach(() => {
  uninstallFakeProvider();
  rmSync(dir, { recursive: true, force: true });
});

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
    planStore: store,
    ...overrides,
  };
}

describe("plan versions from the orchestrator", () => {
  it("plan mode saves a 'planned' version, tags the plan event, and records no outcome", async () => {
    installFakeProvider([PLAN_CALL]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "plan" }));
    const event = log.of("plan")[0]!;
    expect(event.versionId).toBeTruthy();
    expect(event.parentVersionId).toBeNull();
    const version = await store.get(event.versionId!);
    expect(version).toMatchObject({ origin: "planned", prompt: "Add a feature", model: "claude-opus-5", runId: "run-1" });
    expect(version.plan.steps.map((s) => s.id)).toEqual(["api", "ui"]);
    expect(await store.outcomes(version.id)).toEqual([]);
  });

  it("approving an unchanged plan runs it as the same version and records the outcome", async () => {
    installFakeProvider([PLAN_CALL]);
    const planLog = eventLog();
    await orchestrate(input(planLog, { interaction: "plan" }));
    const { versionId, plan } = planLog.of("plan")[0]!;

    installFakeProvider([{ text: "API done." }, { text: "UI done." }]);
    const runLog = eventLog();
    await orchestrate(input(runLog, { plan, planVersionId: versionId, runId: "run-2" }));
    expect(runLog.of("plan")[0]!.versionId).toBe(versionId);
    expect(await store.list()).toHaveLength(1);
    const [outcome] = await store.outcomes(versionId!);
    expect(outcome).toMatchObject({ runId: "run-2", status: "done", model: "claude-opus-5", replans: 0 });
    expect(outcome!.steps).toEqual([
      { id: "api", outcome: "done" },
      { id: "ui", outcome: "done" },
    ]);
  });

  it("an edited plan becomes a new 'edited' version whose parent is the approved one", async () => {
    installFakeProvider([PLAN_CALL]);
    const planLog = eventLog();
    await orchestrate(input(planLog, { interaction: "plan" }));
    const { versionId, plan } = planLog.of("plan")[0]!;

    const edited: RunPlan = { ...plan, steps: [plan.steps[0]!, { ...plan.steps[1]!, role: "generalist" }] };
    installFakeProvider([{ error: httpError(400, "bad request") }, { text: "UI done." }]);
    const log = eventLog();
    await orchestrate(input(log, { plan: edited, planVersionId: versionId, runId: "run-3" }));
    const event = log.of("plan")[0]!;
    expect(event.versionId).not.toBe(versionId);
    expect(event.parentVersionId).toBe(versionId);
    const child = await store.get(event.versionId!);
    expect(child.origin).toBe("edited");
    expect(child.plan.steps[1]!.role).toBe("generalist");
    const [outcome] = await store.outcomes(child.id);
    expect(outcome!.steps.map((s) => s.outcome)).toEqual(["failed", "skipped"]);
    expect(await store.outcomes(versionId!)).toEqual([]);
  });

  it("re-runs a stored version", async () => {
    const { version } = await store.create({
      plan: {
        summary: "One step.",
        steps: [{ id: "only", title: "Only", role: "backend", detail: "", files: ["src/x.ts"], dependsOn: [] }],
        waves: [["only"]],
      },
      prompt: "Make x",
      model: "claude-opus-5",
      origin: "planned",
    });
    const rerun = await rerunInput(store, version.id);
    expect(rerun).toMatchObject({ request: "Make x", planVersionId: version.id, model: "claude-opus-5" });

    installFakeProvider([{ text: "Done." }]);
    const log = eventLog();
    await orchestrate(input(log, { ...rerun, runId: "rerun-1" }));
    expect(log.of("plan")[0]!.versionId).toBe(version.id);
    expect((await store.outcomes(version.id)).map((o) => o.runId)).toEqual(["rerun-1"]);
    expect(await store.list()).toHaveLength(1);
  });

  it("a second plan in one run is saved as a 'replan' child and counts recovery replans", async () => {
    const recorder = await createPlanRecorder({ store, prompt: "p", runId: "r" });
    const log = eventLog();
    const emit = recorder.wrap(log.emit);
    const plan: RunPlan = {
      summary: "",
      steps: [{ id: "a", title: "A", role: "backend", detail: "", files: [], dependsOn: [] }],
      waves: [["a"]],
    };
    emit({ type: "run_start", runId: "r", mode: "orchestrated", model: "m", at: Date.now() });
    emit({ type: "plan", plan, awaitingApproval: false });
    emit({ type: "recovery", agentId: "a", failureClass: "no_progress", action: "replan", detail: "stuck" });
    emit({ type: "plan", plan: { ...plan, steps: [{ ...plan.steps[0]!, detail: "try another way" }] }, awaitingApproval: false });
    emit({ type: "agent_done", agentId: "a", summary: "ok", tokensIn: 0, tokensOut: 0, cost: 0, durationMs: 1 });
    emit({ type: "run_done", status: "done", summary: "", filesChanged: 1, durationMs: 5, costUsd: 0 });
    await recorder.flush();

    const [first, second] = log.of("plan");
    expect(second!.parentVersionId).toBe(first!.versionId);
    expect((await store.get(second!.versionId!)).origin).toBe("replan");
    const [outcome] = await store.outcomes(second!.versionId!);
    expect(outcome).toMatchObject({ replans: 1, steps: [{ id: "a", outcome: "done" }] });
  });

  it("versioning is off for a workspace that is not on disk unless a store is given", async () => {
    installFakeProvider([PLAN_CALL]);
    const log = eventLog();
    await orchestrate(input(log, { interaction: "plan", planStore: undefined }));
    expect(log.of("plan")[0]!.versionId).toBeUndefined();
  });
});
