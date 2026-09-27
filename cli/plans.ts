/**
 * `viberon plan …` and `viberon experiment …` — the CLI side of lib/plans
 * and lib/experiments. Same stores as the desktop app (`<repo>/.viberon/`),
 * so versions and experiments made here show up in the Plans panel and
 * vice versa.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExperimentRecord, ExperimentVariant } from "@/lib/experiments/types";
import type { PlanVersionSummary } from "@/lib/plans/types";

export const PLANS_USAGE = `  viberon plan list [--repo <path>] [--json]
  viberon plan show <id> [--repo <path>] [--json]
  viberon plan diff <a> <b> [--repo <path>] [--json]
      plan versions saved by the orchestrator in <repo>/.viberon/plans/
  viberon experiment run --repo <path> (--task <text> | --plan <id>) [options]
      --variants <spec>   models=a,b[;plans=<id>,<id>] — one branch per combination
      --prompts-file <f>  prompt variants, one per line (crossed with the models)
      --concurrency <n>   branches at once (default 2, max 4)
      --from-ref <ref>    fork from a commit or tree instead of the current work tree
      --max-turns <n>  --timeout <sec>  --test-cmd <cmd>  --no-gate
      --keep-worktrees    keep each branch's worktree (default: removed; patches are kept)
      --json              print the record and comparison as JSON
  viberon experiment list|show <id>|promote <id> <branch>|undo <id>|discard <id> [--purge] [--repo <path>] [--json]`;

export class PlansCliError extends Error {}

export type PlanArgs =
  | { command: "plan"; action: "list"; repo: string; json: boolean }
  | { command: "plan"; action: "show"; repo: string; id: string; json: boolean }
  | { command: "plan"; action: "diff"; repo: string; a: string; b: string; json: boolean };

export interface ExperimentRunArgs {
  command: "experiment";
  action: "run";
  repo: string;
  task?: string;
  plan?: string;
  variants: ExperimentVariant[];
  promptsFile?: string;
  concurrency?: number;
  fromRef?: string;
  maxTurns?: number;
  timeoutSec?: number;
  testCmd?: string;
  noGate: boolean;
  keepWorktrees: boolean;
  json: boolean;
}

export type ExperimentArgs =
  | ExperimentRunArgs
  | { command: "experiment"; action: "list"; repo: string; json: boolean }
  | { command: "experiment"; action: "show" | "undo"; repo: string; id: string; json: boolean }
  | { command: "experiment"; action: "discard"; repo: string; id: string; purge: boolean; json: boolean }
  | { command: "experiment"; action: "promote"; repo: string; id: string; branch: string; json: boolean };

const BOOLEAN = new Set(["json", "no-gate", "keep-worktrees", "purge", "help"]);

function split(argv: string[]): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new PlansCliError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

const str = (flags: Map<string, string | true>, name: string) => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};

function int(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = str(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new PlansCliError(`--${name} must be a positive integer`);
  return n;
}

function only(flags: Map<string, string | true>, allowed: string[], where: string): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw new PlansCliError(`Unknown option for ${where}: --${name}`);
  }
}

/** `models=a,b;plans=pv_x,pv_y` → one variant per model × plan. */
export function parseVariantSpec(spec: string): ExperimentVariant[] {
  const parts = new Map<string, string[]>();
  for (const chunk of spec.split(";").map((c) => c.trim()).filter(Boolean)) {
    const eq = chunk.indexOf("=");
    if (eq === -1) throw new PlansCliError(`--variants: expected key=value, got "${chunk}"`);
    const key = chunk.slice(0, eq).trim();
    if (key !== "models" && key !== "plans") throw new PlansCliError(`--variants: unknown key "${key}" (models or plans)`);
    const values = chunk.slice(eq + 1).split(",").map((v) => v.trim()).filter(Boolean);
    if (!values.length) throw new PlansCliError(`--variants: ${key} has no values`);
    parts.set(key, [...(parts.get(key) ?? []), ...values]);
  }
  const models = parts.get("models") ?? [undefined];
  const plans = parts.get("plans") ?? [undefined];
  const variants: ExperimentVariant[] = [];
  for (const model of models) {
    for (const plan of plans) {
      variants.push({ ...(model ? { model } : {}), ...(plan ? { planVersionId: plan } : {}) });
    }
  }
  return variants;
}

export function parsePlanArgs(argv: string[]): PlanArgs {
  const { flags, positionals } = split(argv);
  only(flags, ["repo", "json"], "plan");
  const [action = "list", ...rest] = positionals;
  const repo = str(flags, "repo") ?? ".";
  const json = flags.has("json");
  if (action === "list") return { command: "plan", action, repo, json };
  if (action === "show") {
    if (!rest[0]) throw new PlansCliError("plan show: a version id is required");
    return { command: "plan", action, repo, id: rest[0], json };
  }
  if (action === "diff") {
    if (!rest[0] || !rest[1]) throw new PlansCliError("plan diff: two version ids are required");
    return { command: "plan", action, repo, a: rest[0], b: rest[1], json };
  }
  throw new PlansCliError(`plan: unknown action "${action}" (list, show or diff)`);
}

export function parseExperimentArgs(argv: string[]): ExperimentArgs {
  const { flags, positionals } = split(argv);
  const [action = "", ...rest] = positionals;
  const repo = str(flags, "repo") ?? ".";
  const json = flags.has("json");
  if (action === "run") {
    only(
      flags,
      ["repo", "task", "plan", "variants", "prompts-file", "concurrency", "from-ref", "max-turns", "timeout", "test-cmd", "no-gate", "keep-worktrees", "json"],
      "experiment run",
    );
    if (!str(flags, "repo")) throw new PlansCliError("experiment run: --repo is required");
    const task = str(flags, "task");
    const plan = str(flags, "plan");
    if (!task && !plan) throw new PlansCliError("experiment run: --task or --plan is required");
    if (plan && str(flags, "from-ref")) throw new PlansCliError("experiment run: --plan forks from the work tree; drop --from-ref");
    const spec = str(flags, "variants");
    const variants = spec ? parseVariantSpec(spec) : [{}];
    const concurrency = int(flags, "concurrency");
    if (concurrency !== undefined && concurrency > 4) throw new PlansCliError("--concurrency is at most 4");
    return {
      command: "experiment",
      action,
      repo,
      ...(task ? { task } : {}),
      ...(plan ? { plan } : {}),
      variants,
      ...(str(flags, "prompts-file") ? { promptsFile: str(flags, "prompts-file") } : {}),
      ...(concurrency ? { concurrency } : {}),
      ...(str(flags, "from-ref") ? { fromRef: str(flags, "from-ref") } : {}),
      ...(int(flags, "max-turns") ? { maxTurns: int(flags, "max-turns") } : {}),
      ...(int(flags, "timeout") ? { timeoutSec: int(flags, "timeout") } : {}),
      ...(str(flags, "test-cmd") ? { testCmd: str(flags, "test-cmd") } : {}),
      noGate: flags.has("no-gate"),
      keepWorktrees: flags.has("keep-worktrees"),
      json,
    };
  }
  only(flags, ["repo", "json", "purge"], `experiment ${action || ""}`.trim());
  if (flags.has("purge") && action !== "discard") throw new PlansCliError("--purge only applies to discard");
  if (action === "list") return { command: "experiment", action, repo, json };
  if (action === "show" || action === "undo" || action === "discard" || action === "promote") {
    const id = rest[0];
    if (!id) throw new PlansCliError(`experiment ${action}: an experiment id is required`);
    if (action === "promote") {
      if (!rest[1]) throw new PlansCliError("experiment promote: a branch id (b1, b2, …) is required");
      return { command: "experiment", action, repo, id, branch: rest[1], json };
    }
    if (action === "discard") return { command: "experiment", action, repo, id, purge: flags.has("purge"), json };
    return { command: "experiment", action, repo, id, json };
  }
  throw new PlansCliError(`experiment: unknown action "${action}" (run, list, show, promote, undo or discard)`);
}

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

function versionLine(v: PlanVersionSummary): string {
  const outcome = v.lastOutcome ? `${v.lastOutcome.status} (${v.runs} run${v.runs === 1 ? "" : "s"})` : "never run";
  const prompt = v.prompt.replace(/\s+/g, " ").slice(0, 60);
  return `${v.id}  ${v.origin.padEnd(10)} ${String(v.steps).padStart(2)} steps  ${outcome.padEnd(18)} ${v.intact ? "" : "[MODIFIED] "}${prompt}`;
}

export async function planCommand(args: PlanArgs, io: CliIo): Promise<number> {
  const { PlanStore } = await import("@/lib/plans/store");
  const store = new PlanStore(path.resolve(args.repo));
  if (args.action === "list") {
    const versions = await store.list();
    if (args.json) io.out(`${JSON.stringify({ versions }, null, 2)}\n`);
    else if (!versions.length) io.out("No plan versions yet.\n");
    else io.out(`${versions.map(versionLine).join("\n")}\n`);
    return 0;
  }
  if (args.action === "show") {
    const version = await store.get(args.id);
    const [outcomes, lineage] = await Promise.all([store.outcomes(args.id), store.lineage(args.id)]);
    if (args.json) {
      io.out(`${JSON.stringify({ version, outcomes, lineage: lineage.map((v) => v.id) }, null, 2)}\n`);
      return 0;
    }
    const lines = [
      `${version.id}  (${version.origin}${version.parentId ? ` from ${version.parentId}` : ""})`,
      `model ${version.model}  created ${new Date(version.createdAt).toISOString()}`,
      `prompt: ${version.prompt}`,
      ...(version.plan.summary ? [`summary: ${version.plan.summary}`] : []),
      "",
      ...version.plan.steps.map((s, i) => {
        const wave = version.plan.waves.findIndex((w) => w.includes(s.id)) + 1;
        const deps = s.dependsOn.length ? `  after ${s.dependsOn.join(", ")}` : "";
        return `${i + 1}. [w${wave}] ${s.id}  ${s.title}  (${s.role})${deps}\n     files: ${s.files.join(", ") || "-"}`;
      }),
      "",
      outcomes.length
        ? `runs:\n${outcomes.map((o) => `  ${new Date(o.finishedAt).toISOString()}  ${o.status}  ${o.filesChanged} files  $${o.costUsd.toFixed(3)}${o.experiment ? `  (experiment ${o.experiment.id}/${o.experiment.branchId})` : ""}`).join("\n")}`
        : "runs: none",
    ];
    io.out(`${lines.join("\n")}\n`);
    return 0;
  }
  const { diffPlans, renderPlanDiff } = await import("@/lib/plans/diff");
  const [a, b] = await Promise.all([store.get(args.a), store.get(args.b)]);
  const diff = diffPlans(a, b);
  io.out(args.json ? `${JSON.stringify(diff, null, 2)}\n` : renderPlanDiff(diff));
  return 0;
}

function experimentLine(e: ExperimentRecord): string {
  const done = e.branches.filter((b) => b.status === "done").length;
  const promoted = e.promotion && !e.promotion.undoneAt ? `  promoted ${e.promotion.branchId}` : "";
  return `${e.id}  ${e.status.padEnd(11)} ${done}/${e.branches.length} branches  winner ${e.winner ?? "-"}${promoted}  ${e.task.replace(/\s+/g, " ").slice(0, 50)}`;
}

export async function experimentCommand(args: ExperimentArgs, io: CliIo, log: (line: string) => void): Promise<number> {
  const lib = await import("@/lib/experiments");
  const repo = path.resolve(args.repo);

  if (args.action === "run") {
    let variants = args.variants;
    if (args.promptsFile) {
      const prompts = (await readFile(args.promptsFile, "utf8")).split("\n").map((p) => p.trim()).filter(Boolean);
      if (!prompts.length) throw new PlansCliError(`${args.promptsFile} has no prompts`);
      variants = variants.flatMap((v) => prompts.map((prompt) => ({ ...v, prompt })));
    }
    if (variants.length > lib.MAX_VARIANTS) throw new PlansCliError(`At most ${lib.MAX_VARIANTS} branches (got ${variants.length}).`);
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.once("SIGINT", onSignal);
    try {
      const record = await lib.runExperiment({
        repo,
        ...(args.task ? { task: args.task } : {}),
        source: args.plan ? { kind: "plan", versionId: args.plan } : args.fromRef ? { kind: "ref", ref: args.fromRef } : { kind: "workspace" },
        variants,
        ...(args.concurrency ? { concurrency: args.concurrency } : {}),
        ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        ...(args.timeoutSec ? { timeoutMs: args.timeoutSec * 1000 } : {}),
        ...(args.testCmd ? { testCmd: args.testCmd } : {}),
        noGate: args.noGate,
        keepWorktrees: args.keepWorktrees,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "experiment_start") log(`experiment ${event.experiment.id}: ${event.experiment.branches.length} branches, ${event.experiment.concurrency} at a time`);
          else if (event.type === "branch_start" && event.worktree) log(`${event.branchId}: running in ${event.worktree}`);
          else if (event.type === "branch_done") log(`${event.branch.id}: ${event.branch.evidence?.status ?? event.branch.status}${event.branch.error ? ` (${event.branch.error})` : ""}`);
        },
      });
      const comparison = lib.compareExperiment(record);
      const jsonPath = path.join(repo, lib.EXPERIMENTS_DIR, record.id, "comparison.json");
      await writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
      if (args.json) io.out(`${JSON.stringify({ experiment: record, comparison }, null, 2)}\n`);
      else {
        io.out(lib.renderComparison(comparison));
        io.out(`json: ${jsonPath}\n`);
        if (record.winner) io.out(`promote: viberon experiment promote ${record.id} ${record.winner} --repo ${args.repo}\n`);
      }
      return record.winner ? 0 : 1;
    } finally {
      process.removeListener("SIGINT", onSignal);
    }
  }

  if (args.action === "list") {
    const all = await lib.listExperiments(repo);
    if (args.json) io.out(`${JSON.stringify({ experiments: all }, null, 2)}\n`);
    else io.out(all.length ? `${all.map(experimentLine).join("\n")}\n` : "No experiments yet.\n");
    return 0;
  }

  const record =
    args.action === "show"
      ? await lib.loadExperiment(repo, args.id)
      : args.action === "promote"
        ? await lib.promoteBranch({ repo, id: args.id, branchId: args.branch })
        : args.action === "undo"
          ? await lib.undoPromotion({ repo, id: args.id })
          : await lib.discardExperiment({ repo, id: args.id, purge: "purge" in args && args.purge });
  const comparison = lib.compareExperiment(record);
  if (args.json) io.out(`${JSON.stringify({ experiment: record, comparison }, null, 2)}\n`);
  else {
    if (args.action === "promote") io.out(`Applied ${args.branch}'s patch. Undo with: viberon experiment undo ${record.id} --repo ${args.repo}\n`);
    else if (args.action === "undo") io.out("Promotion undone.\n");
    else if (args.action === "discard") io.out(`Discarded: worktrees removed${args.purge ? " and the record deleted" : ""}.\n`);
    io.out(`${experimentLine(record)}\n`);
    if (args.action === "show") io.out(lib.renderComparison(comparison));
  }
  return 0;
}
