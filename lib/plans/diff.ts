/**
 * Structural diff of two plans: which steps were added, removed or changed
 * (and in which fields), and which files changed owner. Steps are matched
 * by id first, then by title, so a renamed id still reads as one changed
 * step rather than a remove plus an add.
 */

import type { PlanStep, RunPlan } from "@/lib/agents/events";
import type { PlanVersion } from "@/lib/plans/types";

export type StepField = "title" | "role" | "detail" | "files" | "dependsOn";

export interface StepChange {
  id: string;
  /** Set when the step was matched by title under a different id. */
  previousId?: string;
  title: string;
  fields: StepField[];
  before: PlanStep;
  after: PlanStep;
  filesAdded: string[];
  filesRemoved: string[];
  dependsAdded: string[];
  dependsRemoved: string[];
}

export interface OwnershipChange {
  file: string;
  /** Owning step id in A (null: nobody owned it). */
  before: string | null;
  after: string | null;
}

export interface PlanDiff {
  a: { id?: string; steps: number; waves: number };
  b: { id?: string; steps: number; waves: number };
  summaryChanged: boolean;
  promptChanged: boolean;
  modelChanged: boolean;
  added: PlanStep[];
  removed: PlanStep[];
  changed: StepChange[];
  unchanged: string[];
  /** The surviving steps appear in a different order. */
  reordered: boolean;
  ownership: OwnershipChange[];
  wavesChanged: boolean;
  /** Nothing structural differs. */
  identical: boolean;
}

type Side = RunPlan | PlanVersion;

function planOf(side: Side): RunPlan {
  return "plan" in side ? side.plan : side;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

function owners(plan: RunPlan): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of plan.steps) for (const file of step.files) if (!map.has(file)) map.set(file, step.id);
  return map;
}

function compareStep(before: PlanStep, after: PlanStep): StepChange | null {
  const fields: StepField[] = [];
  if (before.title !== after.title) fields.push("title");
  if (before.role !== after.role) fields.push("role");
  if (before.detail !== after.detail) fields.push("detail");
  if (!sameList([...before.files].sort(), [...after.files].sort())) fields.push("files");
  if (!sameList([...before.dependsOn].sort(), [...after.dependsOn].sort())) fields.push("dependsOn");
  const renamed = before.id !== after.id;
  if (!fields.length && !renamed) return null;
  return {
    id: after.id,
    ...(renamed ? { previousId: before.id } : {}),
    title: after.title,
    fields,
    before,
    after,
    filesAdded: minus(after.files, before.files),
    filesRemoved: minus(before.files, after.files),
    dependsAdded: minus(after.dependsOn, before.dependsOn),
    dependsRemoved: minus(before.dependsOn, after.dependsOn),
  };
}

export function diffPlans(aSide: Side, bSide: Side): PlanDiff {
  const a = planOf(aSide);
  const b = planOf(bSide);
  const aVersion = "plan" in aSide ? aSide : null;
  const bVersion = "plan" in bSide ? bSide : null;

  const bById = new Map(b.steps.map((s) => [s.id, s] as const));
  const pairs: [PlanStep, PlanStep][] = [];
  const unmatchedA: PlanStep[] = [];
  for (const step of a.steps) {
    const match = bById.get(step.id);
    if (match) pairs.push([step, match]);
    else unmatchedA.push(step);
  }
  const matchedB = new Set(pairs.map(([, s]) => s.id));
  let unmatchedB = b.steps.filter((s) => !matchedB.has(s.id));

  // A step whose id changed but whose title did not is the same step, renamed.
  const removed: PlanStep[] = [];
  for (const step of unmatchedA) {
    const title = step.title.trim().toLowerCase();
    const twin = unmatchedB.find((s) => s.title.trim().toLowerCase() === title);
    if (twin) {
      pairs.push([step, twin]);
      unmatchedB = unmatchedB.filter((s) => s !== twin);
    } else removed.push(step);
  }

  const changed: StepChange[] = [];
  const unchanged: string[] = [];
  for (const [before, after] of pairs) {
    const change = compareStep(before, after);
    if (change) changed.push(change);
    else unchanged.push(after.id);
  }
  changed.sort((x, y) => b.steps.indexOf(x.after) - b.steps.indexOf(y.after));

  // The shared steps, taken in A's order: their positions in B must rise too.
  const orderB = [...pairs]
    .sort((x, y) => a.steps.indexOf(x[0]) - a.steps.indexOf(y[0]))
    .map(([, after]) => b.steps.indexOf(after));
  const reordered = orderB.some((v, i) => i > 0 && v < orderB[i - 1]!);

  const ownersA = owners(a);
  const ownersB = owners(b);
  // Ownership compares the step as it is known in B, so a rename alone is not an ownership change.
  const renamedTo = new Map(pairs.map(([before, after]) => [before.id, after.id] as const));
  const ownership: OwnershipChange[] = [];
  for (const file of [...new Set([...ownersA.keys(), ...ownersB.keys()])].sort()) {
    const beforeOwner = ownersA.get(file) ?? null;
    const afterOwner = ownersB.get(file) ?? null;
    const comparable = beforeOwner ? (renamedTo.get(beforeOwner) ?? beforeOwner) : null;
    if (comparable !== afterOwner) ownership.push({ file, before: beforeOwner, after: afterOwner });
  }

  const wavesChanged = JSON.stringify(a.waves) !== JSON.stringify(b.waves);
  const summaryChanged = (a.summary ?? "") !== (b.summary ?? "");
  const promptChanged = Boolean(aVersion && bVersion && aVersion.prompt !== bVersion.prompt);
  const modelChanged = Boolean(aVersion && bVersion && aVersion.model !== bVersion.model);
  const added = unmatchedB;

  return {
    a: { ...(aVersion ? { id: aVersion.id } : {}), steps: a.steps.length, waves: a.waves.length },
    b: { ...(bVersion ? { id: bVersion.id } : {}), steps: b.steps.length, waves: b.waves.length },
    summaryChanged,
    promptChanged,
    modelChanged,
    added,
    removed,
    changed,
    unchanged,
    reordered,
    ownership,
    wavesChanged,
    identical:
      !added.length && !removed.length && !changed.length && !ownership.length && !reordered && !summaryChanged && !promptChanged,
  };
}

/** Plain-text rendering for the CLI. */
export function renderPlanDiff(diff: PlanDiff): string {
  const lines: string[] = [];
  const name = (side: PlanDiff["a"], fallback: string) => side.id ?? fallback;
  lines.push(`--- ${name(diff.a, "a")}  (${diff.a.steps} steps, ${diff.a.waves} waves)`);
  lines.push(`+++ ${name(diff.b, "b")}  (${diff.b.steps} steps, ${diff.b.waves} waves)`);
  if (diff.identical) {
    lines.push(diff.modelChanged ? "Same plan; only the model differs." : "No structural differences.");
    return `${lines.join("\n")}\n`;
  }
  if (diff.promptChanged) lines.push("~ prompt changed");
  if (diff.modelChanged) lines.push("~ model changed");
  if (diff.summaryChanged) lines.push("~ summary changed");
  for (const step of diff.added) lines.push(`+ ${step.id}  ${step.title}  [${step.role}]  ${step.files.join(", ") || "(no files)"}`);
  for (const step of diff.removed) lines.push(`- ${step.id}  ${step.title}  [${step.role}]  ${step.files.join(", ") || "(no files)"}`);
  for (const change of diff.changed) {
    const rename = change.previousId ? ` (was ${change.previousId})` : "";
    lines.push(`~ ${change.id}${rename}  ${change.title}: ${change.fields.join(", ") || "id"}`);
    if (change.fields.includes("role")) lines.push(`    role ${change.before.role} -> ${change.after.role}`);
    if (change.fields.includes("title")) lines.push(`    title "${change.before.title}" -> "${change.after.title}"`);
    if (change.filesAdded.length) lines.push(`    + files ${change.filesAdded.join(", ")}`);
    if (change.filesRemoved.length) lines.push(`    - files ${change.filesRemoved.join(", ")}`);
    if (change.dependsAdded.length) lines.push(`    + depends on ${change.dependsAdded.join(", ")}`);
    if (change.dependsRemoved.length) lines.push(`    - depends on ${change.dependsRemoved.join(", ")}`);
  }
  if (diff.reordered) lines.push("~ steps reordered");
  if (diff.ownership.length) {
    lines.push("File ownership:");
    for (const o of diff.ownership) lines.push(`  ${o.file}: ${o.before ?? "(none)"} -> ${o.after ?? "(none)"}`);
  }
  if (diff.wavesChanged) lines.push("~ execution waves changed");
  return `${lines.join("\n")}\n`;
}
