"use client";

/**
 * Browser side of plan versions and experiments: typed calls to
 * /api/plans and /api/experiments, and the experiment event stream.
 */

import type { ExperimentComparison } from "@/lib/experiments/compare";
import type {
  ExperimentEvent,
  ExperimentRecord,
  ExperimentSource,
  ExperimentVariant,
} from "@/lib/experiments/types";
import type { PlanDiff } from "@/lib/plans/diff";
import type { PlanRunOutcome, PlanVersion, PlanVersionSummary } from "@/lib/plans/types";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(url, init);
    const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok || !body) return { ok: false, error: body?.error ?? `Request failed (${response.status})` };
    return { ok: true, data: body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const q = (repoKey: string) => `repoKey=${encodeURIComponent(repoKey)}`;
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface PlanDetail {
  version: PlanVersion;
  outcomes: PlanRunOutcome[];
  lineage: { id: string; origin: PlanVersion["origin"]; createdAt: number }[];
  children: PlanVersionSummary[];
}

export const listPlanVersions = (repoKey: string) =>
  call<{ versions: PlanVersionSummary[] }>(`/api/plans?${q(repoKey)}`);

export const getPlanVersion = (repoKey: string, id: string) =>
  call<PlanDetail>(`/api/plans/${encodeURIComponent(id)}?${q(repoKey)}`);

export const diffPlanVersions = (repoKey: string, a: string, b: string) =>
  call<{ diff: PlanDiff; a: PlanVersion; b: PlanVersion }>(
    `/api/plans/diff?${q(repoKey)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
  );

export const listExperimentRecords = (repoKey: string) =>
  call<{ experiments: ExperimentRecord[] }>(`/api/experiments?${q(repoKey)}`);

export const getExperiment = (repoKey: string, id: string) =>
  call<{ experiment: ExperimentRecord; comparison: ExperimentComparison; active: boolean }>(
    `/api/experiments/${encodeURIComponent(id)}?${q(repoKey)}`,
  );

export const comparePatches = (repoKey: string, id: string) =>
  call<{ comparison: ExperimentComparison; patches: Record<string, string> }>(
    `/api/experiments/${encodeURIComponent(id)}/compare?${q(repoKey)}&patches=1`,
  );

export interface NewExperiment {
  task?: string;
  source: ExperimentSource;
  variants: ExperimentVariant[];
  concurrency?: number;
  maxTurns?: number;
}

export const createExperimentRequest = (repoKey: string, input: NewExperiment) =>
  call<{ experiment: ExperimentRecord }>("/api/experiments", post({ repoKey, ...input }));

export const promoteExperimentBranch = (repoKey: string, id: string, branchId: string) =>
  call<{ experiment: ExperimentRecord }>(`/api/experiments/${encodeURIComponent(id)}/promote`, post({ repoKey, branchId }));

export const undoExperimentPromotion = (repoKey: string, id: string) =>
  call<{ experiment: ExperimentRecord }>(`/api/experiments/${encodeURIComponent(id)}/promote`, post({ repoKey, undo: true }));

export const discardExperimentRequest = (repoKey: string, id: string, purge = false) =>
  call<{ experiment: ExperimentRecord }>(`/api/experiments/${encodeURIComponent(id)}/discard`, post({ repoKey, purge }));

/**
 * Follow an experiment's SSE stream until it ends or `signal` aborts.
 * Resolves when the stream closes.
 */
export async function followExperiment(
  repoKey: string,
  id: string,
  onEvent: (event: ExperimentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/experiments/${encodeURIComponent(id)}/events?${q(repoKey)}`, { signal });
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (payload) {
        try {
          onEvent(JSON.parse(payload) as ExperimentEvent);
        } catch {
          // A malformed frame is skipped, not fatal.
        }
      }
      cut = buffer.indexOf("\n\n");
    }
  }
}

/**
 * The experiment form's variants: one branch per model × prompt. Models
 * are comma- or space-separated; prompts are one per line (none = the
 * task). With neither, a single default branch. Capped at `max`.
 */
export function variantsFromForm(models: string, prompts: string, max = 8): ExperimentVariant[] {
  const modelList = [...new Set(models.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean))];
  const promptList = [...new Set(prompts.split("\n").map((p) => p.trim()).filter(Boolean))];
  const variants: ExperimentVariant[] = [];
  for (const model of modelList.length ? modelList : [undefined]) {
    for (const prompt of promptList.length ? promptList : [undefined]) {
      variants.push({
        ...(model ? { model } : {}),
        ...(prompt ? { prompt, label: `${model ? `${model} · ` : ""}${prompt.slice(0, 24)}` } : {}),
      });
    }
  }
  return variants.slice(0, max);
}

/** Apply one live event to a record held in component state. */
export function applyExperimentEvent(record: ExperimentRecord | null, event: ExperimentEvent): ExperimentRecord | null {
  switch (event.type) {
    case "experiment_start":
    case "experiment_done":
      return event.experiment;
    case "branch_start":
      if (!record) return record;
      return {
        ...record,
        branches: record.branches.map((b) =>
          b.id === event.branchId ? { ...b, status: "running", worktree: event.worktree ?? b.worktree } : b,
        ),
      };
    case "branch_done":
      if (!record) return record;
      return { ...record, branches: record.branches.map((b) => (b.id === event.branch.id ? event.branch : b)) };
    default:
      return record;
  }
}
