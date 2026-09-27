/**
 * Experiments: one task forked into N branches, each a variant (model,
 * prompt or plan), each run in its own git worktree, each scored with the
 * harness's evidence. See docs/PLAN_VERSIONING.md.
 */

import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import type { SolveStatus } from "@/lib/harness/solve-types";

export const EXPERIMENT_SCHEMA_VERSION = 1;

/** Where the branches fork from. Every source resolves to one git tree. */
export type ExperimentSource =
  /** The main workspace as it is now, uncommitted changes included. */
  | { kind: "workspace" }
  /** A plan version: the branches run that plan (or variants of it) on the current workspace. */
  | { kind: "plan"; versionId: string }
  /** A store checkpoint (the Changes panel's snapshots). */
  | { kind: "checkpoint"; checkpointId: string }
  /** A git tree or commit, e.g. a harness checkpoint event's `ref`. */
  | { kind: "ref"; ref: string };

/** What one branch changes relative to the experiment's base. */
export interface ExperimentVariant {
  label?: string;
  model?: string;
  /** Replaces the experiment's task text. */
  prompt?: string;
  /** Run this plan (an edited plan) through the orchestrator. */
  plan?: RunPlan;
  /** Run this saved plan version. */
  planVersionId?: string;
}

export type BranchStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface BranchScore {
  /** Higher is better; only meaningful within one experiment. */
  value: number;
  /** 1 = best. */
  rank: number;
  /** The parts that went into the rank, in order of precedence. */
  verdictTier: number;
  regressions: number;
  fixed: number;
  diffLines: number;
  costUsd: number;
  tokens: number;
  durationMs: number;
}

export interface BranchEvidence {
  status: SolveStatus;
  summary: string;
  gateReason: string;
  fixed: string[];
  regressed: string[];
  filesChanged: string[];
  diff: { files: number; adds: number; removes: number };
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  modelCalls: number;
  error?: string;
}

export interface ExperimentBranch {
  id: string;
  label: string;
  /** The variant as run (plans are referenced by version id). */
  variant: { model: string; prompt?: string; planVersionId?: string; mode: "solve" | "plan" };
  status: BranchStatus;
  /** The branch's worktree while it exists; null once discarded. */
  worktree: string | null;
  /** Evidence bundle: result.json, patch.diff, report.md, trajectory.jsonl. */
  outDir: string;
  startedAt?: number;
  finishedAt?: number;
  evidence?: BranchEvidence;
  score?: BranchScore;
  error?: string;
}

export type ExperimentStatus = "running" | "done" | "cancelled" | "interrupted" | "discarded";

export interface ExperimentPromotion {
  branchId: string;
  at: number;
  /** Snapshot of the main workspace just before the patch was applied. */
  beforeTree: string;
  /** Snapshot right after; undo checks the workspace still matches. */
  afterTree: string;
  /** Store checkpoint taken before applying (IDE), restorable from the Changes panel. */
  checkpointId?: string;
  undoneAt?: number;
}

export interface ExperimentRecord {
  schemaVersion: number;
  id: string;
  repo: string;
  task: string;
  source: ExperimentSource;
  /** The git tree every branch starts from. */
  baseTree: string;
  concurrency: number;
  createdAt: number;
  finishedAt?: number;
  status: ExperimentStatus;
  branches: ExperimentBranch[];
  /** Branch id of the best branch with a change, when there is one. */
  winner: string | null;
  promotion?: ExperimentPromotion;
  discardedAt?: number;
}

/** Progress events, streamed over SSE by `GET /api/experiments/:id/events`. */
export type ExperimentEvent =
  | { type: "experiment_start"; experiment: ExperimentRecord }
  | { type: "branch_start"; branchId: string; worktree: string | null }
  /** A condensed subset of the branch's orchestration events. */
  | { type: "branch_event"; branchId: string; event: OrchestrationEvent }
  | { type: "branch_done"; branch: ExperimentBranch }
  | { type: "experiment_done"; experiment: ExperimentRecord }
  | { type: "experiment_error"; message: string };
