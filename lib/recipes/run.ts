/**
 * Running a recipe.
 *
 * Not a second engine: a recipe is a fixed plan, and each step goes through
 * the machinery the rest of Viberon already uses.
 *
 *   agent  → `runAgent` exactly as the orchestrator runs a plan step (same
 *            task framing, owned files as the write lock, role tools, fresh
 *            engine and memory per step); role `solver` → `solveTask`, the
 *            full localize / gate / retry loop.
 *   shell  → the terminal (`runCommand`) after the same policy and
 *            blocklist check `run_command` applies (`classifyCommand`, the
 *            command policy, and the run's approval channel).
 *   verify → `lib/verify`: the repository's detected checks, or a custom
 *            command (policy-checked like a shell step), parsed per test.
 *
 * Progress is the ordinary `OrchestrationEvent` stream (plan, waves, lanes,
 * verification, commands), so the run view, the SSE route and the headless
 * trajectory need nothing recipe-specific. `recipeSolver` adapts a recipe
 * to the `SolveOptions → SolveResult` contract, which is how the CLI plugs
 * it into `runHeadless` (evidence bundle, worktree, exit codes).
 */

import type { EventSink, OrchestrationEvent, PlanStep, RunPlan, RunStatus } from "@/lib/agents/events";
import { buildEngine, buildStepTask } from "@/lib/agents/orchestrator";
import { getRole, type RoleId } from "@/lib/agents/roles";
import { loadRules } from "@/lib/agents/rules";
import { runAgent, type AgentRunResult, type ApprovalRequester } from "@/lib/agents/runner";
import { addUsage, EMPTY_USAGE, type AiUsage } from "@/lib/ai/types";
import { ContextLedger } from "@/lib/context/engine";
import { changedFiles, diff, snapshot } from "@/lib/harness/snapshot";
import type { SolveOptions, SolveResult, SolveStatus } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import { evaluateCondition, parseCondition, renderTemplate, type TemplateContext } from "@/lib/recipes/expr";
import { coerceParam } from "@/lib/recipes/schema";
import type {
  AgentStep,
  ParamValue,
  Recipe,
  RecipeStep,
  ShellStep,
  StepOutcome,
  StepStatus,
  VerifyStep,
} from "@/lib/recipes/types";
import { classifyCommand, runCommand } from "@/lib/terminal";
import { condenseOutput, detectVerifyCommands, runVerification } from "@/lib/verify";
import type { VerificationReport, VerifyCommand } from "@/lib/verify/types";
import { refreshMemory, type WorkspaceHandle } from "@/lib/workspace";

/** What a step can hand to later steps through `{{steps.<id>.output}}`. */
const MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

export interface RecipeDeps {
  runAgent?: typeof runAgent;
  solve?: (options: SolveOptions) => Promise<SolveResult>;
  runCommand?: typeof runCommand;
  runVerification?: typeof runVerification;
  detectVerifyCommands?: typeof detectVerifyCommands;
}

export interface RecipeRunOptions {
  recipe: Recipe;
  /** Resolved values (see `resolveParams`). */
  params: Record<string, ParamValue>;
  handle: WorkspaceHandle;
  model: string;
  emit: EventSink;
  signal?: AbortSignal;
  runId: string;
  /** Same meaning as for agents: "ask" routes commands off the safe list to `requestApproval`. */
  commandPolicy: "auto" | "ask" | "never";
  editPolicy?: "auto" | "ask";
  requestApproval?: ApprovalRequester;
  /** Checks for `verify: auto` steps (default: detected in the repository). */
  verifyCommands?: VerifyCommand[];
  verifyTimeoutMs?: number;
  /** Turn budget for solver steps without their own max_turns. */
  maxTurns?: number;
  /** Load AGENTS.md / CLAUDE.md for agent steps (as untrusted conventions). */
  useRepoRules?: boolean;
  deps?: RecipeDeps;
}

export interface RecipeRunResult {
  status: "succeeded" | "failed" | "cancelled";
  steps: StepOutcome[];
  summary: string;
  /** The last verify step's report. */
  lastVerification: VerificationReport | null;
  /** A verify step passed after the last agent or shell step that ran. */
  verifiedAfterLastChange: boolean;
  filesTouched: string[];
  usage: AiUsage;
  cost: number;
  uncachedCost: number;
  modelCalls: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
}

/** The lane role a step shows up as in the run view. */
function laneRole(step: RecipeStep): RoleId {
  if (step.kind === "agent") return step.role as RoleId;
  return step.kind === "shell" ? "devops" : "tester";
}

function cap(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text;
}

function oneLine(text: string, max = 160): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The recipe as a plan, so the run view shows every step up front. */
export function recipePlan(recipe: Recipe, params: Record<string, ParamValue>): RunPlan {
  // Show step-output references as written; they are only known at run time.
  const ctx: TemplateContext = {
    params,
    outputs: Object.fromEntries(recipe.steps.map((s) => [s.id, `{{steps.${s.id}.output}}`])),
  };
  const steps: PlanStep[] = recipe.steps.map((step, i) => ({
    id: step.id,
    title: renderTemplate(step.title, ctx),
    role: laneRole(step),
    detail:
      (step.when ? `When: ${step.when}\n\n` : "") +
      (step.kind === "agent"
        ? renderTemplate(step.prompt, ctx)
        : step.kind === "shell"
          ? `$ ${renderTemplate(step.command, ctx, "shell")}`
          : step.command
            ? `Check: ${renderTemplate(step.command, ctx, "shell")}`
            : `Run the repository's ${step.checkKind ?? "detected"} checks`),
    files: step.kind === "agent" ? step.files.map((f) => renderTemplate(f, ctx)) : [],
    dependsOn: i > 0 ? [recipe.steps[i - 1].id] : [],
  }));
  return {
    summary: `${recipe.description} (recipe ${recipe.name} v${recipe.version})`,
    steps,
    waves: steps.map((s) => [s.id]),
  };
}

export async function executeRecipe(options: RecipeRunOptions): Promise<RecipeRunResult> {
  const { recipe, emit, handle } = options;
  const deps = options.deps ?? {};
  const outcomes: Record<string, StepStatus> = {};
  const outputs: Record<string, string> = {};
  const results: StepOutcome[] = [];
  const filesTouched = new Set<string>();
  let failed = false;
  let lastVerification: VerificationReport | null = null;
  let lastChangeIndex = -1;
  let lastVerifiedIndex = -1;
  const totals = {
    usage: EMPTY_USAGE as AiUsage,
    cost: 0,
    uncachedCost: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolCallsByName: {} as Record<string, number>,
  };
  const rules = options.useRepoRules
    ? (await loadRules(handle).catch(() => ({ text: "" }))).text
    : "";
  const ledger = new ContextLedger();

  emit({ type: "plan", plan: recipePlan(recipe, options.params), awaitingApproval: false });

  for (let index = 0; index < recipe.steps.length; index += 1) {
    const step = recipe.steps[index];
    const ctx: TemplateContext = { params: options.params, outputs };
    const title = renderTemplate(step.title, ctx);
    emit({ type: "wave_start", wave: index, stepIds: [step.id] });

    let skipReason: string | null = null;
    if (options.signal?.aborted) skipReason = "the run was stopped";
    else if (step.when !== undefined) {
      const run = evaluateCondition(parseCondition(step.when), { params: options.params, outcomes, failed });
      if (!run) skipReason = `condition \`${step.when}\` was false`;
    } else if (failed) skipReason = "an earlier step failed";

    if (skipReason) {
      const error = `Skipped: ${skipReason}.`;
      emit({ type: "agent_start", agentId: step.id, stepId: step.id, role: laneRole(step), title, model: options.model, wave: index });
      emit({ type: "agent_done", agentId: step.id, summary: error, tokensIn: 0, tokensOut: 0, cost: 0, durationMs: 0, error });
      outcomes[step.id] = "skipped";
      outputs[step.id] = "";
      results.push({ id: step.id, kind: step.kind, title, status: "skipped", output: "", error: skipReason, durationMs: 0 });
      emit({ type: "wave_end", wave: index });
      continue;
    }

    const startedAt = Date.now();
    let outcome: { ok: boolean; output: string; error?: string };
    try {
      if (step.kind === "agent") {
        const run = await runAgentStep(step, index, title, ctx, options, rules, ledger, results);
        totals.usage = addUsage(totals.usage, run.usage);
        totals.cost += run.cost;
        totals.uncachedCost += run.uncachedCost;
        totals.modelCalls += run.modelCalls;
        totals.toolCalls += run.toolCalls;
        for (const [name, n] of Object.entries(run.toolCallsByName)) {
          totals.toolCallsByName[name] = (totals.toolCallsByName[name] ?? 0) + n;
        }
        for (const f of run.files) filesTouched.add(f);
        outcome = run;
        lastChangeIndex = index;
      } else if (step.kind === "shell") {
        emit({ type: "agent_start", agentId: step.id, stepId: step.id, role: "devops", title, model: "harness", wave: index });
        outcome = await runShellStep(step, ctx, options, deps);
        lastChangeIndex = index;
      } else {
        emit({ type: "agent_start", agentId: step.id, stepId: step.id, role: "tester", title, model: "harness", wave: index });
        const verified = await runVerifyStep(step, ctx, options, deps);
        if (verified.report) lastVerification = verified.report;
        if (verified.ok) lastVerifiedIndex = index;
        outcome = verified;
      }
    } catch (error) {
      outcome = { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
    const durationMs = Date.now() - startedAt;
    if (step.kind !== "agent") {
      if (outcome.output) emit({ type: "agent_text", agentId: step.id, text: `${cap(outcome.output, 4000)}\n` });
      emit({
        type: "agent_done",
        agentId: step.id,
        summary: outcome.ok ? oneLine(outcome.output) || "Done." : (outcome.error ?? "Failed."),
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        durationMs,
        ...(outcome.ok ? {} : { error: outcome.error ?? "Failed." }),
      });
    }

    const status: StepStatus = outcome.ok ? "succeeded" : "failed";
    outcomes[step.id] = status;
    outputs[step.id] = cap(outcome.output || outcome.error || "");
    results.push({
      id: step.id,
      kind: step.kind,
      title,
      status,
      output: outputs[step.id],
      ...(outcome.ok ? {} : { error: outcome.error ?? "failed" }),
      durationMs,
    });
    if (!outcome.ok && !step.continueOnError) failed = true;
    emit({ type: "wave_end", wave: index });
  }

  const status = options.signal?.aborted ? "cancelled" : failed ? "failed" : "succeeded";
  return {
    status,
    steps: results,
    summary: summarize(recipe, status, results),
    lastVerification,
    verifiedAfterLastChange: lastVerifiedIndex > lastChangeIndex,
    filesTouched: [...filesTouched],
    ...totals,
  };
}

/* ------------------------------- agent ----------------------------------- */

interface AgentStepRun {
  ok: boolean;
  output: string;
  error?: string;
  files: string[];
  usage: AiUsage;
  cost: number;
  uncachedCost: number;
  modelCalls: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
}

function briefing(recipe: Recipe, index: number, params: Record<string, ParamValue>, done: StepOutcome[]): string {
  const parts = [
    `You are step ${index + 1} of ${recipe.steps.length} of the recipe "${recipe.name}" (v${recipe.version}): ${recipe.description}`,
  ];
  const values = Object.entries(params).filter(([, v]) => v !== "");
  if (values.length) parts.push(`Recipe parameters:\n${values.map(([k, v]) => `- ${k}: ${String(v)}`).join("\n")}`);
  if (done.length) {
    parts.push(
      `Earlier steps:\n${done
        .map((s) => `- ${s.title}: ${s.status}${s.output ? ` — ${oneLine(s.output, 300)}` : ""}`)
        .join("\n")}`,
    );
  }
  const later = recipe.steps.slice(index + 1);
  if (later.length) {
    parts.push(`Later steps handle these; do not do their work:\n${later.map((s) => `- ${s.title || s.id}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

async function runAgentStep(
  step: AgentStep,
  index: number,
  title: string,
  ctx: TemplateContext,
  options: RecipeRunOptions,
  rules: string,
  ledger: ContextLedger,
  done: StepOutcome[],
): Promise<AgentStepRun> {
  const deps = options.deps ?? {};
  const prompt = renderTemplate(step.prompt, ctx);
  const files = step.files.map((f) => renderTemplate(f, ctx).trim()).filter(Boolean);
  for (const file of files) {
    if (file.startsWith("/") || file.split("/").includes("..")) throw new Error(`owned file "${file}" is outside the repository`);
  }
  const brief = briefing(options.recipe, index, options.params, done);

  if (step.role === "solver") {
    if (!options.handle.rootPath) throw new Error("a solver step needs a workspace on disk");
    const solve = deps.solve ?? (await import("@/lib/harness/solve")).solveTask;
    // The solver narrates its own attempts; its run-level events belong to the recipe.
    const emit: EventSink = (event: OrchestrationEvent) => {
      if (event.type !== "run_start" && event.type !== "run_done") options.emit(event);
    };
    const commands =
      options.verifyCommands ?? (await (deps.detectVerifyCommands ?? detectVerifyCommands)(options.handle.rootPath).catch(() => []));
    const result = await solve({
      handle: options.handle,
      task: `${prompt}\n\n## Context\n\n${brief}`,
      model: options.model,
      emit,
      signal: options.signal,
      runId: options.runId,
      budget: { maxTurns: step.maxTurns ?? options.maxTurns ?? 40 },
      verify: {
        enabled: true,
        commands,
        timeoutMs: options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
        baseline: true,
      },
      useRepoRules: options.useRepoRules ?? false,
    });
    const ok = result.status === "resolved" || result.status === "unverified";
    return {
      ok,
      output: result.summary,
      ...(ok ? {} : { error: result.error ?? `the solver ended ${result.status}: ${oneLine(result.summary)}` }),
      files: result.filesChanged,
      usage: {
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        cacheReadTokens: result.metrics.cacheReadTokens,
        cacheWriteTokens: result.metrics.cacheWriteTokens,
      },
      cost: result.metrics.costUsd,
      uncachedCost: result.metrics.uncachedCostUsd,
      modelCalls: result.metrics.modelCalls,
      toolCalls: result.metrics.toolCalls,
      toolCallsByName: result.metrics.toolCallsByName,
    };
  }

  // Fresh memory and engine per step, as between the orchestrator's waves:
  // this step sees what the previous ones built.
  const memory = await refreshMemory(options.handle);
  const engine = await buildEngine(options.handle, memory, ledger);
  const role = getRole(step.role);
  const planStep: PlanStep = { id: step.id, title, role: step.role as RoleId, detail: prompt, files, dependsOn: [] };
  const result: AgentRunResult = await (deps.runAgent ?? runAgent)({
    agentId: step.id,
    stepId: step.id,
    role: step.role as RoleId,
    model: options.model,
    title,
    task: buildStepTask(planStep),
    briefing: brief,
    files,
    handle: options.handle,
    engine,
    memory,
    commandPolicy: options.commandPolicy,
    editPolicy: options.editPolicy,
    requestApproval: options.requestApproval,
    emit: options.emit,
    signal: options.signal,
    runId: options.runId,
    rules,
    wave: index,
    maxIterations: step.maxTurns ?? role.maxIterations,
    ...(step.tools ? { tools: step.tools } : {}),
    // Recipes run exactly the tools they declare; repository MCP servers are not loaded.
    mcp: false,
  });
  return {
    ok: !result.error,
    output: result.summary,
    ...(result.error ? { error: result.error } : {}),
    files: result.filesTouched,
    usage: result.usage,
    cost: result.cost,
    uncachedCost: result.uncachedCost,
    modelCalls: result.metrics?.modelCalls ?? 0,
    toolCalls: result.metrics?.toolCalls ?? 0,
    toolCallsByName: result.metrics?.toolCallsByName ?? {},
  };
}

/* ------------------------------- shell ----------------------------------- */

/**
 * The same decision `run_command` makes for an agent: blocked commands never
 * run; commands off the auto-approve list run under "auto", are asked about
 * under "ask" (refused when nobody can answer), and nothing runs under
 * "never". Returns the refusal, or null to go ahead.
 */
export async function commandRefusal(
  command: string,
  stepId: string,
  options: Pick<RecipeRunOptions, "commandPolicy" | "requestApproval">,
): Promise<string | null> {
  if (options.commandPolicy === "never") return "command execution is disabled (command policy: never)";
  const verdict = classifyCommand(command);
  if (verdict.allowed === false) return `refused: this command ${verdict.reason}; Viberon never runs it`;
  if (!verdict.needsApproval || options.commandPolicy === "auto") return null;
  if (!options.requestApproval) {
    return "the command is not on the auto-approve list and this run cannot ask for approval (the CLI needs --allow-commands)";
  }
  const approved = await options.requestApproval(stepId, {
    kind: "command",
    title: command,
    reason: "recipe step; not on the auto-approve list",
    detail: { command },
    alwaysKey: `command:${command}`,
  });
  return approved ? null : "the command was declined";
}

async function runShellStep(
  step: ShellStep,
  ctx: TemplateContext,
  options: RecipeRunOptions,
  deps: RecipeDeps,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const root = options.handle.rootPath;
  if (!root) return { ok: false, output: "", error: "shell steps need a workspace on disk" };
  const command = renderTemplate(step.command, ctx, "shell");
  const refusal = await commandRefusal(command, step.id, options);
  if (refusal) return { ok: false, output: "", error: `\`${command}\`: ${refusal}` };

  const result = await (deps.runCommand ?? runCommand)({
    repoKey: options.handle.repoKey,
    command,
    cwd: root,
    timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : DEFAULT_SHELL_TIMEOUT_MS,
    signal: options.signal,
    runId: options.runId,
    origin: "agent",
    repoEnv: true,
    maxOutputChars: 200_000,
  });
  options.emit({
    type: "command",
    agentId: step.id,
    command,
    sessionId: result.sessionId,
    status: result.status,
    exitCode: result.exitCode,
  });
  const output = condenseOutput(result.output, result.exitCode, MAX_OUTPUT_CHARS);
  if (result.exitCode === 0) return { ok: true, output };
  return {
    ok: false,
    output,
    error:
      result.status === "running" || result.status === "killed"
        ? `\`${command}\` did not finish (${options.signal?.aborted ? "stopped" : "timed out"})`
        : `\`${command}\` exited ${result.exitCode ?? "?"}`,
  };
}

/* ------------------------------- verify ---------------------------------- */

async function runVerifyStep(
  step: VerifyStep,
  ctx: TemplateContext,
  options: RecipeRunOptions,
  deps: RecipeDeps,
): Promise<{ ok: boolean; output: string; error?: string; report?: VerificationReport }> {
  const root = options.handle.rootPath;
  if (!root) return { ok: false, output: "", error: "verify steps need a workspace on disk" };

  let check: VerifyCommand;
  if (step.command) {
    const command = renderTemplate(step.command, ctx, "shell");
    const refusal = await commandRefusal(command, step.id, options);
    if (refusal) return { ok: false, output: "", error: `\`${command}\`: ${refusal}` };
    check = { command, framework: "custom", kind: step.checkKind ?? "test", source: `recipe step ${step.id}` };
  } else {
    const detected = options.verifyCommands ?? (await (deps.detectVerifyCommands ?? detectVerifyCommands)(root).catch(() => []));
    const pick = step.checkKind ? detected.find((c) => c.kind === step.checkKind) : detected[0];
    if (!pick) {
      return { ok: false, output: "", error: `no ${step.checkKind ? `${step.checkKind} ` : ""}checks were detected in this repository` };
    }
    check = pick;
  }

  const targets: string[] = [];
  for (const raw of step.targets) {
    const coerced = coerceParam({ name: "target", type: "path", description: "", required: true }, renderTemplate(raw, ctx));
    if ("error" in coerced) return { ok: false, output: "", error: `target ${coerced.error}` };
    targets.push(String(coerced.value));
  }

  const report = await (deps.runVerification ?? runVerification)(root, check, {
    timeoutMs: step.timeoutSec ? step.timeoutSec * 1000 : (options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS),
    signal: options.signal,
    ...(targets.length ? { targets } : {}),
    runId: options.runId,
  });
  const failures = report.counts.failed + report.counts.errors;
  const ok = !report.timedOut && report.exitCode === 0 && failures === 0;
  options.emit({
    type: "verification",
    agentId: step.id,
    phase: "gate",
    command: report.command,
    exitCode: report.exitCode,
    timedOut: report.timedOut,
    passed: report.counts.passed,
    failed: failures,
    newFailures: [],
    fixed: [],
    durationMs: report.durationMs,
    excerpt: report.failureExcerpt.slice(0, 4000),
  });
  const counts = `${report.counts.passed} passed${failures ? `, ${failures} failed` : ""}${report.counts.skipped ? `, ${report.counts.skipped} skipped` : ""}`;
  if (ok) return { ok, output: `\`${report.command}\`: ${counts}`, report };
  return {
    ok,
    output: `\`${report.command}\`: ${counts}\n\n${report.failureExcerpt || report.outputTail}`.trim(),
    error: report.timedOut ? `\`${report.command}\` timed out` : `\`${report.command}\` failed (${counts}, exit ${report.exitCode ?? "?"})`,
    report,
  };
}

/* ------------------------------- summary --------------------------------- */

function summarize(recipe: Recipe, status: RecipeRunResult["status"], steps: StepOutcome[]): string {
  const ran = steps.filter((s) => s.status !== "skipped").length;
  const lines = steps.map((s) => {
    if (s.status === "skipped") return `- **${s.title}** — skipped (${s.error})`;
    if (s.status === "failed") {
      const tolerated = recipe.steps.find((r) => r.id === s.id)?.continueOnError;
      return `- **${s.title}** — failed${tolerated ? " (continued)" : ""}: ${oneLine(s.error ?? "", 240)}`;
    }
    return `- **${s.title}** — ${oneLine(s.output, 240) || "done"}`;
  });
  const verb = status === "succeeded" ? "completed" : status === "cancelled" ? "was stopped" : "failed";
  return `Recipe \`${recipe.name}\` v${recipe.version} ${verb} (${ran} of ${steps.length} steps ran).\n\n${lines.join("\n")}`;
}

/* ------------------------------ as a solve -------------------------------- */

export interface RecipeSolverExtras {
  commandPolicy: RecipeRunOptions["commandPolicy"];
  editPolicy?: RecipeRunOptions["editPolicy"];
  requestApproval?: ApprovalRequester;
  deps?: RecipeDeps;
  /** Called with the recipe-level result (the CLI prints the step table from it). */
  onResult?: (result: RecipeRunResult) => void;
}

function toSolveStatus(run: RecipeRunResult, changed: boolean): SolveStatus {
  if (run.status === "cancelled") return "incomplete";
  if (run.status === "failed") return "failed";
  return run.verifiedAfterLastChange ? "resolved" : changed || run.steps.some((s) => s.status === "succeeded") ? "unverified" : "failed";
}

function runStatus(run: RecipeRunResult): RunStatus {
  return run.status === "succeeded" ? "done" : run.status;
}

/**
 * A recipe behind the `SolveOptions → SolveResult` contract, so
 * `runHeadless` (and the API route) run it like any other task: snapshot
 * first, diff after, the status mapped onto resolved / unverified / failed.
 */
export function recipeSolver(
  recipe: Recipe,
  params: Record<string, ParamValue>,
  extras: RecipeSolverExtras,
): (options: SolveOptions) => Promise<SolveResult> {
  return async (options) => {
    const startedAt = Date.now();
    const root = options.handle.rootPath;
    options.emit({ type: "run_start", runId: options.runId, mode: "orchestrated", model: options.model, at: startedAt });
    options.emit({ type: "intent", intent: "build", reason: `Running recipe ${recipe.name} v${recipe.version}.` });
    const base = root ? await snapshot(root).catch(() => null) : null;

    let run: RecipeRunResult;
    try {
      run = await executeRecipe({
        recipe,
        params,
        handle: options.handle,
        model: options.model,
        emit: options.emit,
        signal: options.signal,
        runId: options.runId,
        commandPolicy: extras.commandPolicy,
        editPolicy: extras.editPolicy,
        requestApproval: extras.requestApproval,
        ...(options.verify.commands.length ? { verifyCommands: options.verify.commands } : {}),
        verifyTimeoutMs: options.verify.timeoutMs,
        maxTurns: options.budget.maxTurns,
        useRepoRules: options.useRepoRules,
        deps: extras.deps,
      });
    } catch (error) {
      // Like solveTask: an internal failure is a result, never a throw.
      const message = error instanceof Error ? error.message : String(error);
      options.emit({ type: "error", message, fatal: true });
      options.emit({ type: "run_done", status: "failed", summary: `Recipe failed: ${message}`, filesChanged: 0, durationMs: Date.now() - startedAt, costUsd: 0 });
      const failed = emptySolveResult("error", message);
      failed.summary = `Recipe failed: ${message}`;
      failed.metrics.durationMs = Date.now() - startedAt;
      return failed;
    }
    extras.onResult?.(run);

    const patch = root && base ? await diff(root, base).catch(() => "") : "";
    const files = root && base ? (await changedFiles(root, base).catch(() => [])).map((c) => c.path) : run.filesTouched;
    const status = toSolveStatus(run, files.length > 0);
    const v = run.lastVerification;
    const durationMs = Date.now() - startedAt;
    const cacheBase = run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens;
    const result: SolveResult = {
      status,
      summary: run.summary,
      diff: patch,
      filesChanged: files,
      gate: {
        enabled: recipe.steps.some((s) => s.kind === "verify"),
        command: v?.command ?? null,
        baseline: null,
        final: v,
        newFailures: [],
        fixed: [],
        rejections: 0,
        ranAfterLastEdit: run.verifiedAfterLastChange,
        reason: v
          ? `${run.verifiedAfterLastChange ? "verified after the last change" : "not re-verified after the last change"}: ${v.command} exit ${v.exitCode ?? "?"}`
          : "the recipe ran no verify step",
      },
      recovery: { checkpoints: 0, rollbacks: 0, restoredBest: false, stuckEvents: 0, failureClasses: {} },
      metrics: {
        modelCalls: run.modelCalls,
        toolCalls: run.toolCalls,
        toolCallsByName: run.toolCallsByName,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cacheReadTokens: run.usage.cacheReadTokens,
        cacheWriteTokens: run.usage.cacheWriteTokens,
        cacheHitRate: cacheBase ? run.usage.cacheReadTokens / cacheBase : 0,
        costUsd: run.cost,
        uncachedCostUsd: run.uncachedCost,
        contextSentTokens: 0,
        contextSavedTokens: 0,
        compactions: 0,
        verifyRuns: run.steps.filter((s) => s.kind === "verify" && s.status !== "skipped").length,
        verifyMs: run.steps.filter((s) => s.kind === "verify").reduce((n, s) => n + s.durationMs, 0),
        durationMs,
      },
    };
    if (run.status === "failed") {
      const blocking = run.steps.find((s) => s.status === "failed" && !recipe.steps.find((r) => r.id === s.id)?.continueOnError);
      if (blocking?.error) result.error = `${blocking.title}: ${blocking.error}`;
    }
    options.emit({
      type: "run_done",
      status: runStatus(run),
      summary: run.summary,
      filesChanged: files.length,
      durationMs,
      costUsd: run.cost,
    });
    return result;
  };
}

/** One-line description of a recipe invocation (the headless "task"). */
export function describeInvocation(recipe: Recipe, params: Record<string, ParamValue>): string {
  const args = Object.entries(params)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `Recipe ${recipe.name} v${recipe.version}: ${recipe.description}${args ? ` (${args})` : ""}`;
}
