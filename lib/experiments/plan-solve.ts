/**
 * Execute a plan the way a headless solve runs a task: the orchestrator runs
 * the plan's DAG (file locks, waves, specialists), then the harness's gate
 * judges the result on the original and the patched code. The outcome is a
 * `SolveResult`, so a plan branch is scored with exactly the same evidence
 * as a prompt or model branch.
 *
 * It has `solveTask`'s signature and is handed to `runHeadless` as its
 * solver, which supplies the worktree, the detected checks, the hooks and
 * the evidence bundle.
 */

import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { orchestrate as realOrchestrate, type OrchestrationInput } from "@/lib/agents/orchestrator";
import { Gate } from "@/lib/harness/gate";
import { changedFiles, diff, snapshot } from "@/lib/harness/snapshot";
import { toReport, type SolveOptions, type SolveResult } from "@/lib/harness/solve";
import { emptySolveResult } from "@/lib/headless/run";
import type { PlanStore } from "@/lib/plans/store";
import { getGraph } from "@/lib/store";

export interface PlanSolverOptions {
  plan: RunPlan;
  /** The version being run; its outcome is recorded there. */
  planVersionId?: string;
  planStore?: PlanStore | null;
  experiment?: { id: string; branchId: string };
  /** Concurrent specialists within a wave (default 3). */
  concurrency?: number;
  /** Test seam: replaces the orchestrator. */
  orchestrate?: (input: OrchestrationInput) => Promise<void>;
}

export function planSolver(config: PlanSolverOptions): (options: SolveOptions) => Promise<SolveResult> {
  return async (options) => {
    const startedAt = Date.now();
    const { handle, emit } = options;
    const result = emptySolveResult("failed");
    const root = handle.rootPath;
    if (!root) return { ...result, status: "error", error: "Plan runs need a workspace on disk." };

    let orchestration: Extract<OrchestrationEvent, { type: "run_done" }> | null = null;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensCached = 0;
    let cost = 0;
    let uncached = 0;
    let summary = "";
    const byName: Record<string, number> = {};
    const track = (event: OrchestrationEvent) => {
      switch (event.type) {
        case "ledger":
          ({ tokensIn, tokensOut, tokensCached } = event);
          cost = event.costUsd;
          uncached = event.uncachedUsd;
          break;
        case "agent_tool":
          if (event.phase === "start") {
            result.metrics.toolCalls += 1;
            byName[event.tool] = (byName[event.tool] ?? 0) + 1;
          }
          break;
        case "agent_done":
          result.metrics.modelCalls += 1;
          break;
        case "compaction":
          result.metrics.compactions += 1;
          break;
        case "run_done":
          // The gate's ruling ends this run, not the orchestrator's.
          orchestration = event;
          summary = event.summary;
          return;
      }
      emit(event);
    };

    let baseRef = "";
    try {
      baseRef = await snapshot(root);
      const gate = new Gate({
        root,
        baseRef,
        suite: options.verify.commands,
        graph: await getGraph(handle.repoKey),
        timeoutMs: options.verify.timeoutMs,
        emit,
        agentId: "gate",
        signal: options.signal,
        runId: options.runId,
        repoKey: handle.repoKey,
        ...(options.runCheck ? { runner: options.runCheck } : {}),
        ...(options.verifyServices ? { services: options.verifyServices } : {}),
      });
      const gated = options.verify.enabled && options.verify.commands.length > 0;
      const baseline = gated && options.verify.baseline ? gate.startBaseline().catch(() => undefined) : Promise.resolve();

      await (config.orchestrate ?? realOrchestrate)({
        repoKey: handle.repoKey,
        handle,
        request: options.task,
        history: [],
        mode: "orchestrated",
        model: options.model,
        commandPolicy: "auto",
        editPolicy: "auto",
        concurrency: config.concurrency ?? 3,
        interaction: "agent",
        plan: config.plan,
        emit: track,
        signal: options.signal,
        runId: options.runId,
        showThinking: false,
        hooks: options.hooks ?? null,
        ...(config.planVersionId ? { planVersionId: config.planVersionId } : {}),
        ...(config.planStore !== undefined ? { planStore: config.planStore } : {}),
        ...(config.experiment ? { experiment: config.experiment } : {}),
      });
      await baseline;

      result.diff = await diff(root, baseRef);
      result.filesChanged = (await changedFiles(root, baseRef)).map((c) => c.path);
      const v = gated && result.filesChanged.length ? await gate.verify({ summary }, { final: true }) : null;
      if (v) gate.emitResult(v, "final");
      const test = gate.testCommand;
      const net = v?.checks.find((c) => c.origin !== "agent");
      result.gate = {
        enabled: options.verify.enabled,
        command: test?.command ?? null,
        baseline: test ? toReport(test.command, test.kind, await gate.baselineFor(test.command)) : null,
        final: net ? toReport(net.command, "test", net.after) : null,
        newFailures: v?.newFailures ?? [],
        fixed: v?.fixed ?? [],
        rejections: 0,
        ranAfterLastEdit: Boolean(v),
        reason: v?.feedback.split("\n")[0] ?? (options.verify.enabled ? "no verification ran" : "gate disabled"),
      };
      result.metrics.verifyRuns = gate.verifyRuns;
      result.metrics.verifyMs = gate.verifyMs;

      // The same ladder solveTask uses, so plan and prompt branches compare fairly.
      const status = (orchestration as Extract<OrchestrationEvent, { type: "run_done" }> | null)?.status;
      if (!result.diff.trim()) result.status = status === "cancelled" ? "incomplete" : "failed";
      else if (!options.verify.enabled) result.status = "unverified";
      else if (v?.strength === "strong") result.status = "resolved";
      else if (!gated || v?.decision === "accept_unverified") result.status = "unverified";
      else result.status = "incomplete";
      if (options.signal?.aborted && result.status !== "resolved") result.status = "incomplete";
      result.summary = summary || (result.filesChanged.length ? `Changed ${result.filesChanged.join(", ")}.` : "No change was produced.");
    } catch (error) {
      result.status = "error";
      result.error = error instanceof Error ? error.message : String(error);
      result.summary = `Failed: ${result.error}`;
      if (baseRef) result.diff = await diff(root, baseRef).catch(() => "");
    }

    Object.assign(result.metrics, {
      toolCallsByName: byName,
      inputTokens: Math.max(0, tokensIn - tokensCached),
      outputTokens: tokensOut,
      cacheReadTokens: tokensCached,
      cacheHitRate: tokensIn ? tokensCached / tokensIn : 0,
      costUsd: cost,
      uncachedCostUsd: uncached,
      durationMs: Date.now() - startedAt,
    });
    emit({
      type: "run_done",
      status:
        result.status === "resolved" || result.status === "unverified"
          ? "done"
          : result.status === "incomplete"
            ? options.signal?.aborted
              ? "cancelled"
              : "incomplete"
            : "failed",
      summary: result.summary,
      filesChanged: result.filesChanged.length,
      durationMs: result.metrics.durationMs,
      costUsd: cost,
    });
    return result;
  };
}
