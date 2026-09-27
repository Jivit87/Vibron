/**
 * The plan recorder: sits on an orchestration's event stream and turns
 * every `plan` event into a plan version, and the run's end into an outcome
 * on that version.
 *
 * Hooking the stream rather than the planner means every path that shows a
 * plan is versioned the same way — a fresh plan, a plan-mode plan awaiting
 * approval, an approved (possibly edited) plan, and any later plan the run
 * emits after re-planning — without the orchestrator knowing about storage.
 *
 * `emit` is synchronous, so the version id is minted on the spot and put on
 * the event; the file write is queued and `flush()` waits for it.
 */

import type { EventSink, OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { hashPlan, PlanStore } from "@/lib/plans/store";
import type { PlanOrigin, PlanRunOutcome, PlanVersion, StepOutcome } from "@/lib/plans/types";

export interface PlanRecorderOptions {
  store: PlanStore;
  prompt: string;
  runId: string;
  /** The version this run starts from: the plan the user approved or re-ran. */
  parentId?: string | null;
  /** The run executes a plan it was given (rather than planning itself). */
  approved?: boolean;
  /** Tags the outcome when the run is an experiment branch. */
  experiment?: { id: string; branchId: string };
}

export interface PlanRecorder {
  wrap(emit: EventSink): EventSink;
  /** Wait for every queued write. Never rejects. */
  flush(): Promise<void>;
  /** The version the run is currently executing (or proposing). */
  readonly versionId: string | null;
}

export async function createPlanRecorder(options: PlanRecorderOptions): Promise<PlanRecorder> {
  const { store } = options;
  // Loaded up front: deciding "same as the parent?" must not wait on disk inside emit.
  let parent: PlanVersion | null = null;
  if (options.parentId) parent = await store.get(options.parentId).catch(() => null);

  let current: PlanVersion | null = null;
  let executing = false;
  let plans = 0;
  let model = "";
  let startedAt = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  let replans = 0;
  const steps = new Map<string, { outcome: StepOutcome; error?: string }>();
  let queue: Promise<void> = Promise.resolve();
  let warned = false;

  const enqueue = (work: () => Promise<void>, forward: EventSink) => {
    queue = queue.then(work).catch((error: unknown) => {
      if (warned) return;
      warned = true;
      forward({
        type: "error",
        message: `Could not save the plan version: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      });
    });
  };

  const versionFor = (plan: RunPlan): { version: PlanVersion; created: boolean } => {
    const first = plans === 0;
    plans += 1;
    let origin: PlanOrigin;
    let parentId: string | null;
    if (first) {
      if (options.approved && parent && hashPlan(plan, options.prompt) === parent.hash) {
        return { version: parent, created: false };
      }
      origin = options.approved ? (parent ? "edited" : "planned") : "planned";
      parentId = parent?.id ?? null;
    } else {
      origin = "replan";
      parentId = current?.id ?? parent?.id ?? null;
    }
    const version = PlanStore.prepare({
      plan,
      prompt: options.prompt,
      model,
      origin,
      parentId,
      runId: options.runId,
      ...(options.experiment ? { note: `experiment ${options.experiment.id} / ${options.experiment.branchId}` } : {}),
    });
    return { version, created: true };
  };

  const outcomeFor = (event: Extract<OrchestrationEvent, { type: "run_done" }>, version: PlanVersion): PlanRunOutcome => {
    const finishedAt = Date.now();
    return {
      versionId: version.id,
      runId: options.runId,
      status: event.status ?? "done",
      model,
      startedAt,
      finishedAt,
      durationMs: event.durationMs,
      filesChanged: event.filesChanged,
      costUsd: event.costUsd,
      tokensIn,
      tokensOut,
      steps: version.plan.steps.map((s) => ({ id: s.id, ...(steps.get(s.id) ?? { outcome: "not_run" as const }) })),
      replans,
      ...(options.experiment ? { experiment: options.experiment } : {}),
    };
  };

  return {
    get versionId() {
      return current?.id ?? null;
    },
    wrap(emit: EventSink): EventSink {
      return (event) => {
        switch (event.type) {
          case "run_start":
            model = event.model;
            startedAt = event.at;
            break;
          case "plan": {
            let recorded: { version: PlanVersion; created: boolean };
            try {
              recorded = versionFor(event.plan);
            } catch {
              emit(event);
              return;
            }
            const previous = current;
            current = recorded.version;
            executing = !event.awaitingApproval;
            if (previous && previous.id !== current.id) steps.clear();
            if (recorded.created) {
              const version = recorded.version;
              enqueue(() => store.commit(version), emit);
            }
            emit({ ...event, versionId: current.id, parentVersionId: current.parentId });
            return;
          }
          case "agent_done":
            steps.set(event.agentId, event.error
              ? { outcome: event.error.startsWith("Skipped") ? "skipped" : "failed", error: event.error.slice(0, 300) }
              : { outcome: "done" });
            break;
          case "recovery":
            if (event.action === "replan") replans += 1;
            break;
          case "ledger":
            tokensIn = event.tokensIn;
            tokensOut = event.tokensOut;
            break;
          case "run_done":
            if (current && executing) {
              const outcome = outcomeFor(event, current);
              enqueue(() => store.recordOutcome(outcome), emit);
            }
            break;
        }
        emit(event);
      };
    },
    flush: () => queue.catch(() => undefined),
  };
}
