/**
 * The plan version store: `<root>/.viberon/plans/`.
 *
 *   versions/<id>.json   one immutable PlanVersion per file (written once,
 *                        exclusive-create, read-only mode, content-hashed)
 *   runs/<id>.jsonl      append-only PlanRunOutcome log for that version
 *
 * A version never changes after it is written. Editing a plan makes a new
 * version whose `parentId` points at the old one; running a version appends
 * an outcome to its run log. `.viberon/` is git-excluded, so none of this
 * reaches a diff.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PlanStep, RunPlan } from "@/lib/agents/events";
import { excludeFromGit } from "@/lib/workspace/graph-index";
import {
  PLAN_SCHEMA_VERSION,
  type PlanOrigin,
  type PlanRunOutcome,
  type PlanVersion,
  type PlanVersionSummary,
} from "@/lib/plans/types";

export const PLANS_DIR = path.join(".viberon", "plans");
const ID_RE = /^pv_[a-z0-9]{6,16}_[a-z0-9]{6,12}$/;

export class PlanStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_id" | "modified" | "exists" | "invalid",
  ) {
    super(message);
    this.name = "PlanStoreError";
  }
}

export function isPlanVersionId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function newPlanVersionId(now = Date.now()): string {
  return `pv_${now.toString(36)}_${randomBytes(5).toString("hex").slice(0, 8)}`;
}

/** The fields of a step that define it, in a fixed key order. */
function canonicalStep(step: PlanStep) {
  return {
    id: step.id,
    title: step.title,
    role: step.role,
    detail: step.detail,
    files: [...step.files],
    dependsOn: [...step.dependsOn],
  };
}

/** A copy of the plan holding only what defines it (waves are derived, but kept for display). */
export function canonicalPlan(plan: RunPlan): RunPlan {
  return {
    summary: plan.summary ?? "",
    steps: (plan.steps ?? []).map(canonicalStep),
    waves: (plan.waves ?? []).map((w) => [...w]),
  };
}

/** Content hash of a plan and the prompt it answers. Waves are derived from steps, so they are left out. */
export function hashPlan(plan: RunPlan, prompt: string): string {
  const canonical = { prompt, summary: plan.summary ?? "", steps: (plan.steps ?? []).map(canonicalStep) };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface CreateVersionInput {
  plan: RunPlan;
  prompt: string;
  model: string;
  origin: PlanOrigin;
  parentId?: string | null;
  runId?: string;
  note?: string;
  /**
   * When the plan and prompt are identical to the parent's, return the
   * parent instead of writing a duplicate (a re-run is not a new version).
   */
  dedupe?: boolean;
}

export class PlanStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, PLANS_DIR);
  }

  private versionPath(id: string): string {
    if (!isPlanVersionId(id)) throw new PlanStoreError(`Not a plan version id: ${String(id).slice(0, 40)}`, "invalid_id");
    return path.join(this.dir, "versions", `${id}.json`);
  }

  private runsPath(id: string): string {
    if (!isPlanVersionId(id)) throw new PlanStoreError(`Not a plan version id: ${String(id).slice(0, 40)}`, "invalid_id");
    return path.join(this.dir, "runs", `${id}.jsonl`);
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(path.join(this.dir, "versions"), { recursive: true });
    await mkdir(path.join(this.dir, "runs"), { recursive: true });
    await excludeFromGit(this.root, "/.viberon/").catch(() => false);
  }

  /** Write a new immutable version (or return the parent when `dedupe` finds it identical). */
  async create(input: CreateVersionInput): Promise<{ version: PlanVersion; created: boolean }> {
    const parentId = input.parentId ?? null;
    const version = PlanStore.prepare(input);
    if (parentId) {
      const parent = await this.get(parentId);
      if (input.dedupe && parent.hash === version.hash) return { version: parent, created: false };
    }
    await this.commit(version);
    return { version, created: true };
  }

  /**
   * Build a version (id, canonical plan, hash) without touching disk, so a
   * caller on a synchronous path can hand out its id before `commit`.
   */
  static prepare(input: CreateVersionInput): PlanVersion {
    if (!input.plan || !Array.isArray(input.plan.steps)) throw new PlanStoreError("A plan needs a steps array.", "invalid");
    const plan = canonicalPlan(input.plan);
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: newPlanVersionId(),
      parentId: input.parentId ?? null,
      origin: input.origin,
      prompt: input.prompt,
      plan,
      model: input.model,
      createdAt: Date.now(),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.note ? { note: input.note } : {}),
      hash: hashPlan(plan, input.prompt),
    };
  }

  /**
   * Exclusive create with a read-only mode: an existing version is never
   * overwritten, and the hash is re-derived so a hand-built record cannot
   * claim content it does not have.
   */
  async commit(version: PlanVersion): Promise<void> {
    if (!PlanStore.intact(version.id, version)) throw new PlanStoreError("The version's hash does not match its content.", "invalid");
    await this.ensureDirs();
    try {
      await writeFile(this.versionPath(version.id), `${JSON.stringify(version, null, 2)}\n`, { flag: "wx", mode: 0o444 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PlanStoreError(`Plan version ${version.id} already exists; versions are immutable.`, "exists");
      }
      throw error;
    }
  }

  private async readRaw(id: string): Promise<PlanVersion> {
    const file = this.versionPath(id);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new PlanStoreError(`Unknown plan version ${id}.`, "not_found");
    }
    try {
      return JSON.parse(text) as PlanVersion;
    } catch {
      throw new PlanStoreError(`Plan version ${id} is not valid JSON.`, "modified");
    }
  }

  private static intact(id: string, version: PlanVersion): boolean {
    return (
      version.id === id &&
      Array.isArray(version.plan?.steps) &&
      typeof version.prompt === "string" &&
      hashPlan(version.plan, version.prompt) === version.hash
    );
  }

  /** A version, verified against its hash; throws `modified` when it was edited on disk. */
  async get(id: string): Promise<PlanVersion> {
    const version = await this.readRaw(id);
    if (!PlanStore.intact(id, version)) {
      throw new PlanStoreError(`Plan version ${id} was modified after it was written.`, "modified");
    }
    return version;
  }

  async has(id: string): Promise<boolean> {
    return isPlanVersionId(id) && existsSync(this.versionPath(id));
  }

  /** Newest first. Versions that fail their hash are listed with `intact: false`. */
  async list(options: { limit?: number } = {}): Promise<PlanVersionSummary[]> {
    let names: string[];
    try {
      names = await readdir(path.join(this.dir, "versions"));
    } catch {
      return [];
    }
    const summaries: PlanVersionSummary[] = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !isPlanVersionId(id)) continue;
      let version: PlanVersion;
      try {
        version = await this.readRaw(id);
      } catch {
        continue;
      }
      const runs = await this.outcomes(id);
      const last = runs.at(-1) ?? null;
      const steps = Array.isArray(version.plan?.steps) ? version.plan.steps : [];
      summaries.push({
        id,
        parentId: version.parentId ?? null,
        origin: version.origin,
        prompt: String(version.prompt ?? ""),
        model: String(version.model ?? ""),
        createdAt: Number(version.createdAt) || 0,
        steps: steps.length,
        waves: Array.isArray(version.plan?.waves) ? version.plan.waves.length : 0,
        files: new Set(steps.flatMap((s) => (Array.isArray(s.files) ? s.files : []))).size,
        runs: runs.length,
        lastOutcome: last
          ? { status: last.status, runId: last.runId, finishedAt: last.finishedAt, filesChanged: last.filesChanged, costUsd: last.costUsd }
          : null,
        intact: PlanStore.intact(id, version),
      });
    }
    summaries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return options.limit ? summaries.slice(0, options.limit) : summaries;
  }

  /** Append the outcome of one run of a version. */
  async recordOutcome(outcome: PlanRunOutcome): Promise<void> {
    if (!(await this.has(outcome.versionId))) {
      throw new PlanStoreError(`Unknown plan version ${outcome.versionId}.`, "not_found");
    }
    await this.ensureDirs();
    await appendFile(this.runsPath(outcome.versionId), `${JSON.stringify(outcome)}\n`);
  }

  /** Every recorded run of a version, oldest first. Torn lines are skipped. */
  async outcomes(id: string): Promise<PlanRunOutcome[]> {
    let text: string;
    try {
      text = await readFile(this.runsPath(id), "utf8");
    } catch {
      return [];
    }
    const out: PlanRunOutcome[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as PlanRunOutcome);
      } catch {
        // A crash mid-append leaves a torn last line; the rest stands.
      }
    }
    return out;
  }

  /** The version and its ancestors, newest first (stops at a missing or cyclic parent). */
  async lineage(id: string): Promise<PlanVersion[]> {
    const chain: PlanVersion[] = [];
    const seen = new Set<string>();
    let next: string | null = id;
    while (next && !seen.has(next) && chain.length < 100) {
      seen.add(next);
      let version: PlanVersion;
      try {
        version = await this.get(next);
      } catch (error) {
        if (chain.length === 0) throw error;
        break;
      }
      chain.push(version);
      next = version.parentId;
    }
    return chain;
  }

  /** Versions whose parent is `id`. */
  async children(id: string): Promise<PlanVersionSummary[]> {
    return (await this.list()).filter((v) => v.parentId === id);
  }
}

/** A store for a workspace on disk; null for workspaces that live only in the app store. */
export function planStoreFor(rootPath: string | null | undefined): PlanStore | null {
  return rootPath ? new PlanStore(rootPath) : null;
}
