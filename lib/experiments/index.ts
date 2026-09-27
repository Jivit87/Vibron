/**
 * Experiment branching.
 *
 * One task is forked into N branches. Each branch is a variant — another
 * model, another prompt, or another (edited) plan — and runs through the
 * same headless path as `viberon run --worktree`, in its own detached git
 * worktree of a common base tree, so branches cannot see or clobber each
 * other or the user's checkout. Branches run concurrently up to a bound.
 *
 * Every branch leaves the usual evidence bundle and is scored with the
 * harness's own evidence (gate verdict, tests fixed and regressed, diff
 * size, tokens, cost, time). The winner can be promoted: its patch is
 * applied to the main workspace behind a snapshot, so promotion can be
 * undone. Discarding removes the worktrees.
 *
 * State lives in `<repo>/.viberon/experiments/<id>/` (git-excluded):
 *   experiment.json          the ExperimentRecord
 *   <branch>/result.json     SolveResult + metadata (runHeadless)
 *   <branch>/patch.diff      the branch's change
 *   <branch>/report.md, trajectory.jsonl
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { renormalizePlan, type OrchestrationInput } from "@/lib/agents/orchestrator";
import { restore, snapshot } from "@/lib/harness/snapshot";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { createWorktree, removeWorktree, runHeadless, type HeadlessOptions } from "@/lib/headless/run";
import { planSolver } from "@/lib/experiments/plan-solve";
import { evidenceFrom, rankBranches } from "@/lib/experiments/scoring";
import {
  EXPERIMENT_SCHEMA_VERSION,
  type ExperimentBranch,
  type ExperimentEvent,
  type ExperimentRecord,
  type ExperimentSource,
  type ExperimentVariant,
} from "@/lib/experiments/types";
import { PlanStore } from "@/lib/plans/store";
import { excludeFromGit } from "@/lib/workspace/graph-index";

export * from "@/lib/experiments/types";
export { compareEvidence, diffStats, evidenceFrom, rankBranches } from "@/lib/experiments/scoring";
export { compareExperiment, renderComparison, type ComparisonRow, type ExperimentComparison } from "@/lib/experiments/compare";

export const EXPERIMENTS_DIR = path.join(".viberon", "experiments");
export const MAX_VARIANTS = 8;
export const MAX_CONCURRENCY = 4;
const ID_RE = /^ex_[a-z0-9]{6,16}_[a-z0-9]{4,12}$/;
const REF_RE = /^(?!-)[\w./^~@{}-]{1,200}$/;

export class ExperimentError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" | "not_git" | "conflict" | "state",
    readonly status = code === "not_found" ? 404 : code === "conflict" || code === "state" ? 409 : 400,
  ) {
    super(message);
    this.name = "ExperimentError";
  }
}

export function isExperimentId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/* ------------------------------ storage ---------------------------------- */

function experimentDir(repo: string, id: string): string {
  if (!isExperimentId(id)) throw new ExperimentError(`Not an experiment id: ${String(id).slice(0, 40)}`, "invalid");
  return path.join(repo, EXPERIMENTS_DIR, id);
}

/** Records are rewritten whole: write a temp file, then rename over. */
async function persist(record: ExperimentRecord): Promise<void> {
  const dir = experimentDir(record.repo, record.id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "experiment.json");
  const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  await fsWriteFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, file);
}

/** Experiments this process is running; anything else still "running" on disk was interrupted. */
const ACTIVE_KEY = Symbol.for("viberon.experiments.active");
type GlobalWithActive = typeof globalThis & { [ACTIVE_KEY]?: Map<string, AbortController> };
const host = globalThis as GlobalWithActive;
const active: Map<string, AbortController> = host[ACTIVE_KEY] ?? new Map();
host[ACTIVE_KEY] = active;

export function isExperimentActive(id: string): boolean {
  return active.has(id);
}

/** Stop a running experiment: every branch's solve is aborted. */
export function cancelExperiment(id: string): boolean {
  const controller = active.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function loadExperiment(repoPath: string, id: string): Promise<ExperimentRecord> {
  const repo = path.resolve(repoPath);
  let text: string;
  try {
    text = await readFile(path.join(experimentDir(repo, id), "experiment.json"), "utf8");
  } catch (error) {
    if (error instanceof ExperimentError) throw error;
    throw new ExperimentError(`Unknown experiment ${id}.`, "not_found");
  }
  const record = JSON.parse(text) as ExperimentRecord;
  if (record.id !== id) throw new ExperimentError(`Experiment ${id} does not match its record.`, "invalid");
  // The record is trusted only for data; the repo is the one we were asked about.
  record.repo = repo;
  if (record.status === "running" && !active.has(id)) {
    record.status = "interrupted";
    for (const b of record.branches) if (b.status === "queued" || b.status === "running") b.status = "cancelled";
  }
  return record;
}

export async function listExperiments(repoPath: string): Promise<ExperimentRecord[]> {
  const repo = path.resolve(repoPath);
  let names: string[];
  try {
    names = await readdir(path.join(repo, EXPERIMENTS_DIR));
  } catch {
    return [];
  }
  const out: ExperimentRecord[] = [];
  for (const name of names.filter(isExperimentId)) {
    try {
      out.push(await loadExperiment(repo, name));
    } catch {
      // A torn or foreign directory is not an experiment.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------ git helpers ------------------------------ */

function git(cwd: string, args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function assertGitRepo(repo: string): void {
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  const same = top.code === 0 && safeRealpath(top.stdout.trim()) === safeRealpath(repo);
  if (!same) throw new ExperimentError("Experiments need the top of a git repository (branches are git worktrees).", "not_git");
  if (git(repo, ["rev-parse", "--verify", "HEAD"]).code !== 0) {
    throw new ExperimentError("Experiments need a git repository with at least one commit.", "not_git");
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/* ------------------------------- sources --------------------------------- */

export interface ExperimentDeps {
  /** Solver for prompt/model branches (default `solveTask`). Test seam. */
  solve?: (options: SolveOptions) => Promise<SolveResult>;
  /** Orchestrator for plan branches (default the real one). Test seam. */
  orchestrate?: (input: OrchestrationInput) => Promise<void>;
  /** Materialize a store checkpoint into a git tree (default: `materializeCheckpoint`). */
  checkpointTree?: (repo: string, checkpointId: string) => Promise<string>;
}

/**
 * A store checkpoint (full file contents, see lib/checkpoints) as a git tree:
 * written into a scratch worktree of HEAD with the same rules as a restore
 * (files created since are deleted), then snapshotted.
 */
export async function materializeCheckpoint(repo: string, checkpointId: string): Promise<string> {
  const { getCheckpoint } = await import("@/lib/checkpoints");
  const checkpoint = await getCheckpoint(checkpointId);
  if (!checkpoint) throw new ExperimentError(`Unknown checkpoint ${checkpointId}.`, "not_found");
  const dir = await createWorktree(repo, `checkpoint-${randomBytes(3).toString("hex")}`);
  try {
    const [{ registerLocalWorkspace }, { listFiles, openWorkspace }] = await Promise.all([
      import("@/lib/local-disk-workspace"),
      import("@/lib/workspace"),
    ]);
    const handle = await openWorkspace((await registerLocalWorkspace(dir)).repoKey);
    const keep = new Set(checkpoint.files.map((f) => f.path));
    for (const file of await listFiles(handle)) {
      if (!keep.has(file.path)) await unlink(path.join(dir, file.path)).catch(() => undefined);
    }
    for (const file of checkpoint.files) {
      const target = path.resolve(dir, file.path);
      if (!target.startsWith(`${dir}${path.sep}`)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await fsWriteFile(target, file.source);
    }
    return await snapshot(dir);
  } finally {
    removeWorktree(repo, dir);
  }
}

async function resolveBaseTree(repo: string, source: ExperimentSource, deps: ExperimentDeps): Promise<string> {
  switch (source.kind) {
    case "workspace":
    case "plan":
      // The work tree as it is, uncommitted and untracked files included.
      return snapshot(repo);
    case "ref": {
      if (!REF_RE.test(source.ref)) throw new ExperimentError("Not a git ref.", "invalid");
      const tree = git(repo, ["rev-parse", "--verify", "--quiet", `${source.ref}^{tree}`]);
      if (tree.code !== 0) throw new ExperimentError(`Unknown git ref or tree: ${source.ref}`, "not_found");
      return tree.stdout.trim();
    }
    case "checkpoint":
      return (deps.checkpointTree ?? materializeCheckpoint)(repo, source.checkpointId);
  }
}

/* ------------------------------- create ---------------------------------- */

export interface ExperimentInput {
  repo: string;
  /** The task; with a plan source it defaults to the version's prompt. */
  task?: string;
  source?: ExperimentSource;
  variants: ExperimentVariant[];
  /** Branches that run at once (default 2, at most 4). */
  concurrency?: number;
  maxTurns?: number;
  timeoutMs?: number;
  testCmd?: string;
  noGate?: boolean;
  /** Keep worktrees after the branches finish, until discard (default true). */
  keepWorktrees?: boolean;
  /** Link ignored dependency dirs into each worktree (default true). */
  linkDependencies?: boolean;
  /** Running inside the app server. */
  embedded?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ExperimentEvent) => void;
}

interface BranchPlan {
  branch: ExperimentBranch;
  prompt: string;
  model?: string;
  plan?: RunPlan;
  planVersionId?: string;
}

export interface PreparedExperiment {
  record: ExperimentRecord;
  input: ExperimentInput;
  deps: ExperimentDeps;
  plans: BranchPlan[];
  store: PlanStore;
}

function newExperimentId(): string {
  return `ex_${Date.now().toString(36)}_${randomBytes(4).toString("hex").slice(0, 6)}`;
}

function variantLabel(variant: ExperimentVariant, index: number, mode: "solve" | "plan"): string {
  if (variant.label?.trim()) return variant.label.trim().slice(0, 60);
  const parts: string[] = [];
  if (variant.model) parts.push(variant.model);
  if (variant.planVersionId) parts.push(`plan ${variant.planVersionId.slice(-6)}`);
  else if (variant.plan) parts.push("edited plan");
  if (variant.prompt) parts.push("prompt variant");
  return parts.join(" · ") || (mode === "plan" ? "plan" : `variant ${index + 1}`);
}

/**
 * Validate the input, resolve the base tree, save plan variants as versions,
 * and write the record. Nothing runs yet.
 */
export async function createExperiment(input: ExperimentInput, deps: ExperimentDeps = {}): Promise<PreparedExperiment> {
  const repo = path.resolve(input.repo);
  if (!existsSync(repo)) throw new ExperimentError(`Repository not found: ${repo}`, "not_found");
  assertGitRepo(repo);
  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (!variants.length) throw new ExperimentError("An experiment needs at least one variant.", "invalid");
  if (variants.length > MAX_VARIANTS) throw new ExperimentError(`At most ${MAX_VARIANTS} variants per experiment.`, "invalid");

  const source: ExperimentSource = input.source ?? { kind: "workspace" };
  const store = new PlanStore(repo);
  const sourceVersion = source.kind === "plan" ? await store.get(source.versionId).catch(() => null) : null;
  if (source.kind === "plan" && !sourceVersion) throw new ExperimentError(`Unknown plan version ${source.versionId}.`, "not_found");

  const task = (input.task?.trim() || sourceVersion?.prompt || "").trim();
  if (!task && variants.some((v) => !v.prompt?.trim())) {
    throw new ExperimentError("A task is required (or a prompt on every variant).", "invalid");
  }

  const baseTree = await resolveBaseTree(repo, source, deps);
  const id = newExperimentId();
  const root = experimentDir(repo, id);
  await mkdir(root, { recursive: true });
  await excludeFromGit(repo, "/.viberon/").catch(() => false);

  const plans: BranchPlan[] = [];
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i]!;
    const prompt = variant.prompt?.trim() || task;
    let plan: RunPlan | undefined;
    let planVersionId: string | undefined;
    let parentId: string | null = sourceVersion?.id ?? null;
    if (variant.planVersionId) {
      const version = await store.get(variant.planVersionId).catch(() => null);
      if (!version) throw new ExperimentError(`Unknown plan version ${variant.planVersionId}.`, "not_found");
      plan = version.plan;
      parentId = version.id;
    }
    if (variant.plan) {
      if (!Array.isArray(variant.plan.steps) || !variant.plan.steps.length) {
        throw new ExperimentError(`Variant ${i + 1}: a plan needs at least one step.`, "invalid");
      }
      plan = renormalizePlan(variant.plan);
    }
    plan ??= sourceVersion?.plan;
    if (plan) {
      // An unchanged plan and prompt run as the version they came from.
      const { version } = await store.create({
        plan,
        prompt,
        model: variant.model ?? sourceVersion?.model ?? "auto",
        origin: "experiment",
        parentId,
        dedupe: true,
        note: `experiment ${id} / b${i + 1}`,
      });
      planVersionId = version.id;
      plan = version.plan;
    }
    const mode = plan ? "plan" : "solve";
    const branchId = `b${i + 1}`;
    plans.push({
      prompt,
      ...(variant.model ? { model: variant.model } : {}),
      ...(plan ? { plan } : {}),
      ...(planVersionId ? { planVersionId } : {}),
      branch: {
        id: branchId,
        label: variantLabel(variant, i, mode),
        variant: {
          model: variant.model ?? "auto",
          ...(prompt !== task ? { prompt } : {}),
          ...(planVersionId ? { planVersionId } : {}),
          mode,
        },
        status: "queued",
        worktree: null,
        outDir: path.join(root, branchId),
      },
    });
  }

  const record: ExperimentRecord = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    id,
    repo,
    task,
    source,
    baseTree,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(input.concurrency ?? 2) || 2)),
    createdAt: Date.now(),
    status: "running",
    branches: plans.map((p) => p.branch),
    winner: null,
  };
  await persist(record);
  return { record, input: { ...input, repo }, deps, plans, store };
}

/* -------------------------------- run ------------------------------------ */

/** Orchestration events worth relaying live; the full stream is in each trajectory.jsonl. */
const RELAYED = new Set<OrchestrationEvent["type"]>([
  "run_start",
  "plan",
  "wave_start",
  "agent_start",
  "agent_done",
  "gate",
  "verification",
  "recovery",
  "run_done",
  "error",
]);

/** Run every branch of a prepared experiment, bounded by its concurrency; resolves with the ranked record. */
export async function runPreparedExperiment(prepared: PreparedExperiment): Promise<ExperimentRecord> {
  const { record, input, deps, plans, store } = prepared;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  active.set(record.id, controller);

  const emit = (event: ExperimentEvent) => {
    try {
      input.onEvent?.(event);
    } catch {
      // Observers never break the experiment.
    }
  };
  // Serialize record writes: branches finish concurrently.
  let writes: Promise<void> = Promise.resolve();
  const save = () => {
    writes = writes.then(() => persist(record)).catch(() => undefined);
    return writes;
  };

  emit({ type: "experiment_start", experiment: structuredClone(record) });

  const runBranch = async (item: BranchPlan) => {
    const { branch } = item;
    if (controller.signal.aborted) {
      branch.status = "cancelled";
      return;
    }
    branch.status = "running";
    branch.startedAt = Date.now();
    emit({ type: "branch_start", branchId: branch.id, worktree: null });
    await save();

    const headless: HeadlessOptions = {
      repo: record.repo,
      task: item.prompt,
      taskId: `${record.id}-${branch.id}`,
      worktree: true,
      keepWorktree: true,
      worktreeOptions: { baseTree: record.baseTree, linkDependencies: input.linkDependencies !== false },
      out: branch.outDir,
      ...(item.model ? { model: item.model } : {}),
      ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.testCmd ? { testCmd: input.testCmd } : {}),
      noGate: Boolean(input.noGate),
      signal: controller.signal,
      recordMemory: false,
      embedded: Boolean(input.embedded),
      log: (line) => {
        const match = /^worktree: (.+)$/.exec(line);
        if (match) {
          branch.worktree = match[1]!;
          emit({ type: "branch_start", branchId: branch.id, worktree: branch.worktree });
        }
      },
      onEvent: (event) => {
        if (RELAYED.has(event.type)) emit({ type: "branch_event", branchId: branch.id, event });
      },
    };
    const solve = item.plan
      ? planSolver({
          plan: item.plan,
          planStore: store,
          experiment: { id: record.id, branchId: branch.id },
          ...(item.planVersionId ? { planVersionId: item.planVersionId } : {}),
          ...(deps.orchestrate ? { orchestrate: deps.orchestrate } : {}),
        })
      : deps.solve;

    try {
      const outcome = await runHeadless(headless, solve ? { solve } : {});
      const result = outcome.result;
      if (result.workRoot && result.workRoot !== record.repo) branch.worktree = result.workRoot;
      branch.variant.model = result.model || branch.variant.model;
      branch.evidence = evidenceFrom(result);
      if (controller.signal.aborted && result.status !== "resolved") branch.status = "cancelled";
      else branch.status = result.status === "error" ? "error" : "done";
      if (result.error) branch.error = result.error;
    } catch (error) {
      branch.status = "error";
      branch.error = error instanceof Error ? error.message : String(error);
    }
    branch.finishedAt = Date.now();
    if (input.keepWorktrees === false && branch.worktree) {
      removeWorktree(record.repo, branch.worktree);
      branch.worktree = null;
    }
    emit({ type: "branch_done", branch: structuredClone(branch) });
    await save();
  };

  try {
    const queue = [...plans];
    const workers = Array.from({ length: Math.min(record.concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await runBranch(item);
    });
    await Promise.all(workers);

    record.winner = rankBranches(record.branches);
    record.status = controller.signal.aborted ? "cancelled" : "done";
    record.finishedAt = Date.now();
    await save();
    emit({ type: "experiment_done", experiment: structuredClone(record) });
    return record;
  } finally {
    active.delete(record.id);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/** Create and run an experiment to completion. */
export async function runExperiment(input: ExperimentInput, deps: ExperimentDeps = {}): Promise<ExperimentRecord> {
  return runPreparedExperiment(await createExperiment(input, deps));
}

/* ---------------------------- promote / undo ----------------------------- */

async function branchPatch(record: ExperimentRecord, branchId: string): Promise<{ branch: ExperimentBranch; patch: string }> {
  const branch = /^b\d{1,2}$/.test(branchId) ? record.branches.find((b) => b.id === branchId) : undefined;
  if (!branch) throw new ExperimentError(`Unknown branch ${branchId}.`, "not_found");
  if (branch.status !== "done" || !branch.evidence) throw new ExperimentError(`Branch ${branchId} has not finished.`, "state");
  const patch = await readFile(path.join(experimentDir(record.repo, record.id), branch.id, "patch.diff"), "utf8").catch(() => "");
  if (!patch.trim()) throw new ExperimentError(`Branch ${branchId} produced no change.`, "state");
  return { branch, patch };
}

export interface PromoteOptions {
  repo: string;
  id: string;
  branchId: string;
  /** Take a store checkpoint first (the IDE passes this so Changes can restore it). */
  checkpoint?: () => Promise<string | null>;
}

/**
 * Apply a branch's patch to the main workspace. The workspace is snapshotted
 * first, the patch must apply cleanly (checked before anything is written),
 * and only the work tree changes — never the index, HEAD or branches.
 */
export async function promoteBranch(options: PromoteOptions): Promise<ExperimentRecord> {
  const record = await loadExperiment(options.repo, options.id);
  if (record.status === "running") throw new ExperimentError("Wait for the experiment to finish before promoting.", "state");
  if (record.promotion && !record.promotion.undoneAt) {
    throw new ExperimentError(`Branch ${record.promotion.branchId} is already promoted; undo it first.`, "state");
  }
  const { branch, patch } = await branchPatch(record, options.branchId);
  const check = git(record.repo, ["apply", "--check", "--binary", "--whitespace=nowarn"], patch);
  if (check.code !== 0) {
    throw new ExperimentError(
      `The patch of ${branch.id} no longer applies to the workspace (it changed since the experiment forked): ${check.stderr.trim().slice(0, 300)}`,
      "conflict",
    );
  }
  const beforeTree = await snapshot(record.repo);
  const checkpointId = options.checkpoint ? await options.checkpoint().catch(() => null) : null;
  const applied = git(record.repo, ["apply", "--binary", "--whitespace=nowarn"], patch);
  if (applied.code !== 0) {
    await restore(record.repo, beforeTree).catch(() => undefined);
    throw new ExperimentError(`Applying ${branch.id} failed: ${applied.stderr.trim().slice(0, 300)}`, "conflict");
  }
  record.promotion = {
    branchId: branch.id,
    at: Date.now(),
    beforeTree,
    afterTree: await snapshot(record.repo),
    ...(checkpointId ? { checkpointId } : {}),
  };
  await persist(record);
  return record;
}

/**
 * Undo a promotion. If the workspace is exactly as the promotion left it,
 * it is restored to the snapshot taken before; otherwise only the branch's
 * patch is reversed, so later edits survive (and a patch that no longer
 * reverses cleanly is refused rather than forced).
 */
export async function undoPromotion(options: { repo: string; id: string }): Promise<ExperimentRecord> {
  const record = await loadExperiment(options.repo, options.id);
  const promotion = record.promotion;
  if (!promotion || promotion.undoneAt) throw new ExperimentError("Nothing to undo: no branch is promoted.", "state");
  const current = await snapshot(record.repo);
  if (current === promotion.afterTree) {
    await restore(record.repo, promotion.beforeTree);
  } else {
    const { patch } = await branchPatch(record, promotion.branchId);
    const reverse = git(record.repo, ["apply", "-R", "--binary", "--whitespace=nowarn"], patch);
    if (reverse.code !== 0) {
      throw new ExperimentError(
        `The workspace changed since the promotion and the patch no longer reverses cleanly.${promotion.checkpointId ? ` Restore checkpoint ${promotion.checkpointId} from the Changes panel instead.` : ""}`,
        "conflict",
      );
    }
  }
  promotion.undoneAt = Date.now();
  await persist(record);
  return record;
}

/* -------------------------------- discard -------------------------------- */

/**
 * Remove every branch worktree (cancelling a running experiment first).
 * Evidence bundles stay unless `purge`, which deletes the whole record. A
 * promoted patch stays in the workspace; undo it separately.
 */
export async function discardExperiment(options: { repo: string; id: string; purge?: boolean }): Promise<ExperimentRecord> {
  const record = await loadExperiment(options.repo, options.id);
  if (cancelExperiment(record.id)) {
    // Let the branches notice the abort before their worktrees go away.
    for (let i = 0; i < 100 && active.has(record.id); i += 1) await new Promise((r) => setTimeout(r, 50));
  }
  const fresh = await loadExperiment(options.repo, options.id);
  for (const branch of fresh.branches) {
    // Only a worktree this experiment created: `<tmp>/viberon-wt-*/<id>-<branch>`.
    if (branch.worktree && path.basename(branch.worktree) === `${fresh.id}-${branch.id}`) {
      removeWorktree(fresh.repo, branch.worktree);
    }
    branch.worktree = null;
  }
  git(fresh.repo, ["worktree", "prune"]);
  fresh.status = "discarded";
  fresh.discardedAt = Date.now();
  if (options.purge) await rm(experimentDir(fresh.repo, fresh.id), { recursive: true, force: true });
  else await persist(fresh);
  return fresh;
}

/** Worktrees git knows about for this repository (for checks and tests). */
export function listWorktrees(repo: string): string[] {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  } catch {
    return [];
  }
}
