/**
 * Plan versions: every task DAG the orchestrator produces or runs, kept as
 * an immutable record so it can be compared, edited into a new version,
 * re-run, or forked into experiments. See docs/PLAN_VERSIONING.md.
 */

import type { RunPlan, RunStatus } from "@/lib/agents/events";

export const PLAN_SCHEMA_VERSION = 1;

/** Why a version exists. */
export type PlanOrigin =
  /** The orchestrator's planner produced it. */
  | "planned"
  /** A user edited a plan (from its parent) before running it. */
  | "edited"
  /** A second plan inside one run: the run re-planned after a recovery. */
  | "replan"
  /** A plan variant created for an experiment branch. */
  | "experiment";

export interface PlanVersion {
  schemaVersion: number;
  /** `pv_<time>_<random>`; also the file name. */
  id: string;
  parentId: string | null;
  origin: PlanOrigin;
  /** The user's request the plan answers. */
  prompt: string;
  /** Steps with their owner ids, roles, files (write locks) and dependencies. */
  plan: RunPlan;
  /** The model that produced (or first ran) this version. */
  model: string;
  createdAt: number;
  /** The run that produced the version, when there was one. */
  runId?: string;
  /** Short free text, e.g. which experiment created it. */
  note?: string;
  /** sha256 of the canonical plan + prompt; guards immutability. */
  hash: string;
}

export type StepOutcome = "done" | "failed" | "skipped" | "not_run";

/** One execution of a version. Appended; a version's content never changes. */
export interface PlanRunOutcome {
  versionId: string;
  runId: string;
  status: RunStatus;
  model: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  filesChanged: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  steps: { id: string; outcome: StepOutcome; error?: string }[];
  /** Forced re-plans (recovery `replan` events) during the run. */
  replans: number;
  experiment?: { id: string; branchId: string };
}

export interface PlanVersionSummary {
  id: string;
  parentId: string | null;
  origin: PlanOrigin;
  prompt: string;
  model: string;
  createdAt: number;
  steps: number;
  waves: number;
  files: number;
  runs: number;
  lastOutcome: Pick<PlanRunOutcome, "status" | "runId" | "finishedAt" | "filesChanged" | "costUsd"> | null;
  /** False when the file no longer matches its recorded hash. */
  intact: boolean;
}
