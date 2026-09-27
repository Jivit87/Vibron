/**
 * Plan versioning: immutable plan versions, their run outcomes, structural
 * diffs, and re-runs. See docs/PLAN_VERSIONING.md.
 */

import type { RunPlan } from "@/lib/agents/events";
import { PlanStore } from "@/lib/plans/store";

export * from "@/lib/plans/types";
export { diffPlans, renderPlanDiff, type PlanDiff, type StepChange, type OwnershipChange } from "@/lib/plans/diff";
export { createPlanRecorder, type PlanRecorder } from "@/lib/plans/recorder";
export { hashPlan, isPlanVersionId, PlanStore, PlanStoreError, planStoreFor, PLANS_DIR } from "@/lib/plans/store";

/** What `orchestrate` needs to run a stored version again. */
export interface RerunInput {
  request: string;
  plan: RunPlan;
  planVersionId: string;
  model: string;
  interaction: "agent";
  mode: "orchestrated";
}

/**
 * The orchestration fields for re-running a version: its prompt and plan,
 * with the version as parent, so an unchanged run is recorded against it.
 * `model` overrides the model the version was made with.
 */
export async function rerunInput(store: PlanStore, id: string, overrides: { model?: string } = {}): Promise<RerunInput> {
  const version = await store.get(id);
  return {
    request: version.prompt,
    plan: version.plan,
    planVersionId: version.id,
    model: overrides.model || version.model || "auto",
    interaction: "agent",
    mode: "orchestrated",
  };
}
