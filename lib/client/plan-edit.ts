/**
 * Pure edits for the plan-review list. Every edit returns a plan whose
 * `dependsOn` only names surviving steps and whose `waves` are recomputed,
 * so what the user approves is exactly what the server will schedule.
 */

import { computeWaves, type PlanStep, type RunPlan } from "@/lib/agents/events";

function normalize(summary: string, steps: PlanStep[]): RunPlan {
  const ids = new Set(steps.map((s) => s.id));
  const cleaned = steps.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => ids.has(d)) }));
  return { summary, steps: cleaned, waves: computeWaves(cleaned) };
}

export function updateStep(plan: RunPlan, id: string, patch: Partial<PlanStep>): RunPlan {
  return normalize(
    plan.summary,
    plan.steps.map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s)),
  );
}

export function removeStep(plan: RunPlan, id: string): RunPlan {
  return normalize(
    plan.summary,
    plan.steps.filter((s) => s.id !== id),
  );
}

/** Move a step up (-1) or down (+1) in display order. */
export function moveStep(plan: RunPlan, id: string, delta: -1 | 1): RunPlan {
  const index = plan.steps.findIndex((s) => s.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= plan.steps.length) return plan;
  const steps = plan.steps.slice();
  const [step] = steps.splice(index, 1);
  steps.splice(target, 0, step);
  return normalize(plan.summary, steps);
}

/** Append a blank step that depends on nothing. */
export function addStep(plan: RunPlan, title: string): RunPlan {
  let n = plan.steps.length + 1;
  const ids = new Set(plan.steps.map((s) => s.id));
  while (ids.has(`user_${n}`)) n += 1;
  return normalize(plan.summary, [
    ...plan.steps,
    {
      id: `user_${n}`,
      title,
      role: "generalist",
      detail: "",
      files: [],
      dependsOn: [],
    } as PlanStep,
  ]);
}
