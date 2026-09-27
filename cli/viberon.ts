/**
 * `viberon` command line. Entry point is `cli/main.ts` (it sets
 * VIBERON_STORE=memory before any store module loads); this module has no
 * side effects so tests can import `parseCliArgs`.
 *
 *   viberon run --repo <path> (--task <text|issue-url> | --task-file <file>)
 *               [--worktree] [--keep-worktree] [--out <dir>] [--test-cmd <cmd>]
 *               [--no-gate] [--max-turns <n>] [--timeout <sec>] [--model <id>]
 *               [--task-id <id>] [--json] [--review [--review-model <id>]]
 *               [--deliver [--issue-url <url>]]
 *   viberon review [--repo <path>] [--base <ref> | --pr <url>] [--model <id>] [--json]
 *   viberon issues [--repo <path>] [--label <l>] [--fix <n,n|all>] [--no-deliver] [--model <id>] [--json]
 *   viberon clone <url|owner/repo|issue-url> [--ref <ref>] [--depth <n>] [--setup] [--json]
 *   viberon eval [--only a,b] [--model <id>] [--max-turns <n>] [--timeout <sec>]
 *   viberon recipe list|show|validate|run|import … (see USAGE)
 */

export const USAGE = `Usage:
  viberon run --repo <path> (--task <text|issue-url> | --task-file <file>) [options]
      --worktree          work in a detached git worktree of HEAD (original untouched)
      --keep-worktree     do not delete the worktree afterwards
      --out <dir>         evidence bundle dir (default <repo>/.viberon/runs/<task-id>)
      --test-cmd <cmd>    verification command (default: auto-detected)
      --no-gate           disable the verification gate
      --max-turns <n>     agent turn budget (default 40)
      --timeout <sec>     wall-clock budget
      --model <id>        model id (default $VIBERON_MODEL, else the best configured model)
      --task-id <id>      id used for the bundle directory
      --json              print result.json to stdout
      --review            review an accepted fix with a cheap model; a high finding sends it back once
      --review-model <id> model for --review (default: the cheapest agentic model)
      --deliver           on a verified fix: branch viberon/<slug>, commit, push, open a draft PR
      --issue-url <url>   with --deliver: comment the PR and evidence on this issue
                          (default: the task, when it is an issue URL)
  viberon review [--repo <path>] [--base <ref> | --pr <url>] [--model <id>] [--json]
      reviews the work tree against HEAD, against the merge base with --base, or a GitHub PR
  viberon issues [--repo <path>] [--label <l>] [--fix <n,n|all>] [--no-deliver] [--model <id>] [--json]
      lists the open GitHub issues of the repo's origin; --fix fixes them one by one, each in its own
      worktree of origin/<default>, and opens a draft PR for every fix its checks prove
  viberon clone <url|owner/repo|issue-url> [--ref <ref>] [--depth <n>] [--setup] [--json]
  viberon eval [--only a,b] [--model <id>] [--max-turns <n>] [--timeout <sec>]
  viberon recipe list [--repo <path>] [--json]
  viberon recipe show <name|file> [--repo <path>] [--json]
  viberon recipe validate <name|file> [--repo <path>] [--json]
  viberon recipe run <name|file> [--param k=v]... [--repo <path>] [options]
      --param k=v         a recipe parameter (repeatable)
      --allow-commands    run shell commands that are not on the auto-approve list
                          (blocked commands never run)
      --worktree, --keep-worktree, --out <dir>, --max-turns <n>, --timeout <sec>,
      --model <id>, --json as for run
  viberon recipe import <https-url|file> [--repo <path> | --global] [--force]
      validates, then saves to <repo>/.viberon/recipes (with --repo) or the global
      recipe dir ($VIBERON_RECIPES_DIR, default ~/Viberon/recipes)

Exit codes (run): 0 resolved/unverified, 1 failed/incomplete, 2 error (delivery never changes them).
Exit codes (recipe run): as run. (recipe validate/import): 0 ok, 1 invalid recipe, 2 error.
Exit codes (review): 0 reviewed, 2 error.
Exit codes (issues): 0 listed / every fix succeeded, 1 some fix failed, 2 error.`;

export interface RunArgs {
  command: "run";
  repo: string;
  task?: string;
  taskFile?: string;
  taskId?: string;
  worktree: boolean;
  keepWorktree: boolean;
  out?: string;
  testCmd?: string;
  noGate: boolean;
  maxTurns?: number;
  timeoutSec?: number;
  model?: string;
  json: boolean;
  deliver?: boolean;
  issueUrl?: string;
  review?: boolean;
  reviewModel?: string;
}

export interface ReviewArgs {
  command: "review";
  repo: string;
  base?: string;
  pr?: string;
  model?: string;
  json: boolean;
}

export interface IssuesArgs {
  command: "issues";
  repo: string;
  label?: string;
  fix?: number[] | "all";
  deliver: boolean;
  model?: string;
  json: boolean;
}

export interface CloneArgs {
  command: "clone";
  url: string;
  ref?: string;
  depth?: number;
  setup: boolean;
  json: boolean;
}

export interface EvalArgs {
  command: "eval";
  only?: string[];
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
}

export type RecipeAction = "list" | "show" | "validate" | "run" | "import";

export interface RecipeArgs {
  command: "recipe";
  action: RecipeAction;
  /** Recipe name or file (show/validate/run), or URL/file (import). */
  target?: string;
  repo?: string;
  params: Record<string, string>;
  json: boolean;
  allowCommands: boolean;
  worktree: boolean;
  keepWorktree: boolean;
  out?: string;
  maxTurns?: number;
  timeoutSec?: number;
  model?: string;
  global: boolean;
  force: boolean;
}

export type CliArgs = RunArgs | ReviewArgs | IssuesArgs | CloneArgs | EvalArgs | RecipeArgs | { command: "help" };

export class CliError extends Error {}

const BOOLEAN_FLAGS = new Set([
  "worktree", "keep-worktree", "no-gate", "json", "setup", "help", "deliver", "review", "no-deliver",
  "allow-commands", "global", "force",
]);

function splitFlags(argv: string[]): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      if (arg === "-h") flags.set("help", true);
      else positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new CliError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

function intFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`--${name} must be a positive number`);
  return value;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

const KNOWN: Record<string, Set<string>> = {
  run: new Set([
    "repo", "task", "task-file", "task-id", "worktree", "keep-worktree", "out", "test-cmd",
    "no-gate", "max-turns", "timeout", "model", "json", "help", "deliver", "issue-url",
    "review", "review-model",
  ]),
  review: new Set(["repo", "base", "pr", "model", "json", "help"]),
  issues: new Set(["repo", "label", "fix", "no-deliver", "model", "json", "help"]),
  clone: new Set(["ref", "depth", "setup", "json", "help"]),
  eval: new Set(["only", "model", "max-turns", "timeout", "help"]),
  recipe: new Set([
    "repo", "param", "json", "allow-commands", "worktree", "keep-worktree", "out", "max-turns",
    "timeout", "model", "global", "force", "help",
  ]),
};

const RECIPE_ACTIONS: RecipeAction[] = ["list", "show", "validate", "run", "import"];
/** Flags each recipe action accepts (beyond --help). */
const RECIPE_FLAGS: Record<RecipeAction, string[]> = {
  list: ["repo", "json"],
  show: ["repo", "json"],
  validate: ["repo", "json"],
  run: ["repo", "param", "json", "allow-commands", "worktree", "keep-worktree", "out", "max-turns", "timeout", "model"],
  import: ["repo", "global", "force"],
};

/** Pull every `--param k=v` / `--param=k=v` out of argv (the only repeatable flag). */
function extractParams(argv: string[]): { rest: string[]; params: Record<string, string>; seen: boolean } {
  const rest: string[] = [];
  const params: Record<string, string> = {};
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    let pair: string | undefined;
    if (arg === "--param") {
      pair = argv[++i];
      if (pair === undefined) throw new CliError("--param needs a value (k=v)");
    } else if (arg.startsWith("--param=")) {
      pair = arg.slice("--param=".length);
    } else {
      rest.push(arg);
      continue;
    }
    seen = true;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (eq === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new CliError(`--param takes name=value, got "${pair}"`);
    if (key in params) throw new CliError(`--param ${key} was given twice`);
    params[key] = pair.slice(eq + 1);
  }
  return { rest, params, seen };
}

function parseRecipeArgs(argv: string[]): RecipeArgs | { command: "help" } {
  const { rest, params, seen } = extractParams(argv);
  const { flags, positionals } = splitFlags(rest);
  if (flags.has("help")) return { command: "help" };
  const [actionRaw, target, ...extra] = positionals;
  if (!actionRaw) throw new CliError(`recipe: an action is required (${RECIPE_ACTIONS.join(", ")})`);
  if (!RECIPE_ACTIONS.includes(actionRaw as RecipeAction)) {
    throw new CliError(`recipe: unknown action "${actionRaw}" (${RECIPE_ACTIONS.join(", ")})`);
  }
  const action = actionRaw as RecipeAction;
  const allowed = new Set(RECIPE_FLAGS[action]);
  for (const name of flags.keys()) {
    if (!KNOWN.recipe!.has(name)) throw new CliError(`Unknown option for recipe: --${name}`);
    if (!allowed.has(name)) throw new CliError(`recipe ${action}: --${name} does not apply`);
  }
  if (seen && !allowed.has("param")) throw new CliError(`recipe ${action}: --param does not apply`);
  if (action === "list" ? target !== undefined : extra.length) {
    throw new CliError(`recipe ${action}: unexpected argument "${action === "list" ? target : extra[0]}"`);
  }
  if (action !== "list" && !target) {
    throw new CliError(`recipe ${action}: ${action === "import" ? "a URL or file" : "a recipe name or file"} is required`);
  }
  if (flags.has("global") && flags.has("repo")) throw new CliError("recipe import: use only one of --repo and --global");
  if (flags.has("keep-worktree") && !flags.has("worktree")) throw new CliError("recipe run: --keep-worktree needs --worktree");
  return {
    command: "recipe",
    action,
    ...(target ? { target } : {}),
    ...(stringFlag(flags, "repo") ? { repo: stringFlag(flags, "repo") } : {}),
    params,
    json: flags.has("json"),
    allowCommands: flags.has("allow-commands"),
    worktree: flags.has("worktree"),
    keepWorktree: flags.has("keep-worktree"),
    ...(stringFlag(flags, "out") ? { out: stringFlag(flags, "out") } : {}),
    ...(intFlag(flags, "max-turns") ? { maxTurns: intFlag(flags, "max-turns") } : {}),
    ...(intFlag(flags, "timeout") ? { timeoutSec: intFlag(flags, "timeout") } : {}),
    ...(stringFlag(flags, "model") ? { model: stringFlag(flags, "model") } : {}),
    global: flags.has("global"),
    force: flags.has("force"),
  };
}

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (!(command in KNOWN)) throw new CliError(`Unknown command: ${command}`);
  if (command === "recipe") return parseRecipeArgs(rest);
  const { flags, positionals } = splitFlags(rest);
  if (flags.has("help")) return { command: "help" };
  for (const name of flags.keys()) {
    if (!KNOWN[command]!.has(name)) throw new CliError(`Unknown option for ${command}: --${name}`);
  }

  if (command === "run") {
    const repo = stringFlag(flags, "repo") ?? positionals[0];
    if (!repo) throw new CliError("run: --repo is required");
    const task = stringFlag(flags, "task");
    const taskFile = stringFlag(flags, "task-file");
    if (!task && !taskFile) throw new CliError("run: --task or --task-file is required");
    if (task && taskFile) throw new CliError("run: use only one of --task and --task-file");
    const issueUrl = stringFlag(flags, "issue-url");
    if (issueUrl && !flags.has("deliver")) throw new CliError("run: --issue-url needs --deliver");
    const reviewModel = stringFlag(flags, "review-model");
    if (reviewModel && !flags.has("review")) throw new CliError("run: --review-model needs --review");
    return {
      command,
      repo,
      task,
      taskFile,
      taskId: stringFlag(flags, "task-id"),
      worktree: flags.has("worktree"),
      keepWorktree: flags.has("keep-worktree"),
      out: stringFlag(flags, "out"),
      testCmd: stringFlag(flags, "test-cmd"),
      noGate: flags.has("no-gate"),
      maxTurns: intFlag(flags, "max-turns"),
      timeoutSec: intFlag(flags, "timeout"),
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
      ...(flags.has("deliver") ? { deliver: true } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      ...(flags.has("review") ? { review: true } : {}),
      ...(reviewModel ? { reviewModel } : {}),
    };
  }
  if (command === "review") {
    const base = stringFlag(flags, "base");
    const pr = stringFlag(flags, "pr");
    if (base && pr) throw new CliError("review: use only one of --base and --pr");
    return {
      command,
      repo: stringFlag(flags, "repo") ?? positionals[0] ?? ".",
      base,
      pr,
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
    };
  }
  if (command === "issues") {
    const fixRaw = stringFlag(flags, "fix");
    let fix: IssuesArgs["fix"];
    if (fixRaw === "all") fix = "all";
    else if (fixRaw !== undefined) {
      const numbers = fixRaw.split(",").map((s) => Number(s.trim().replace(/^#/, "")));
      if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new CliError("issues: --fix takes issue numbers (1,2,3) or all");
      }
      fix = numbers;
    }
    if (flags.has("no-deliver") && !fix) throw new CliError("issues: --no-deliver needs --fix");
    return {
      command,
      repo: stringFlag(flags, "repo") ?? positionals[0] ?? ".",
      label: stringFlag(flags, "label"),
      ...(fix ? { fix } : {}),
      deliver: !flags.has("no-deliver"),
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
    };
  }
  if (command === "clone") {
    const url = positionals[0];
    if (!url) throw new CliError("clone: a repository URL is required");
    return {
      command,
      url,
      ref: stringFlag(flags, "ref"),
      depth: intFlag(flags, "depth"),
      setup: flags.has("setup"),
      json: flags.has("json"),
    };
  }
  const only = stringFlag(flags, "only");
  return {
    command: "eval",
    only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    model: stringFlag(flags, "model"),
    maxTurns: intFlag(flags, "max-turns"),
    timeoutSec: intFlag(flags, "timeout"),
  };
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  const log = (line: string) => process.stderr.write(`[viberon] ${line}\n`);

  if (args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (args.command === "recipe") {
    const { runRecipeCommand } = await import("./recipe");
    return runRecipeCommand(args, log);
  }

  if (args.command === "run") {
    const { runHeadless } = await import("@/lib/headless/run");
    const outcome = await runHeadless({
      repo: args.repo,
      task: args.task,
      taskFile: args.taskFile,
      taskId: args.taskId,
      worktree: args.worktree,
      keepWorktree: args.keepWorktree,
      out: args.out,
      testCmd: args.testCmd,
      noGate: args.noGate,
      maxTurns: args.maxTurns,
      timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
      model: args.model,
      log,
      deliver: args.deliver,
      issueUrl: args.issueUrl,
      review: args.review,
      reviewModel: args.reviewModel,
    });
    if (args.json) process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
    else {
      const r = outcome.result;
      const d = r.delivery;
      process.stdout.write(
        `${r.status.toUpperCase()}  ${r.filesChanged.length} file(s) changed  ${r.metrics.modelCalls} model calls  ` +
          `${(r.metrics.inputTokens + r.metrics.outputTokens).toLocaleString()} tokens  ${(r.metrics.durationMs / 1000).toFixed(0)}s\n` +
          `${r.error ? `error: ${r.error}\n` : ""}evidence: ${outcome.outDir}\n` +
          (d ? ("error" in d ? `not delivered: ${d.error}\n` : `pr: ${d.prUrl}  branch: ${d.branch}\n`) : ""),
      );
    }
    return outcome.exitCode;
  }

  if (args.command === "issues") {
    try {
      const [{ fixIssues, issueRows }, { getTaskQueue }, { registerLocalWorkspace }, path] = await Promise.all([
        import("@/lib/issues"),
        import("@/lib/tasks"),
        import("@/lib/local-disk-workspace"),
        import("node:path"),
      ]);
      const { repoKey } = await registerLocalWorkspace(path.resolve(args.repo));
      const { repo, issues } = await issueRows(repoKey, args.label ? [args.label] : []);
      if (!args.fix) {
        if (args.json) process.stdout.write(`${JSON.stringify({ repo, issues }, null, 2)}\n`);
        else {
          process.stdout.write(`${repo.owner}/${repo.repo}: ${issues.length} open issue${issues.length === 1 ? "" : "s"}\n`);
          for (const i of issues) process.stdout.write(`#${i.number}  ${i.title}${i.labels.length ? `  [${i.labels.join(", ")}]` : ""}\n`);
        }
        return 0;
      }
      const numbers = args.fix === "all" ? issues.map((i) => i.number) : args.fix;
      if (!numbers.length) {
        log("no open issues to fix");
        return 0;
      }
      const { tasks, skipped } = await fixIssues({ repoKey, numbers, deliver: args.deliver, model: args.model, source: "cli" });
      for (const s of skipped) log(`#${s.number} skipped: ${s.reason}`);
      log(`fixing ${tasks.length} issue${tasks.length === 1 ? "" : "s"} one at a time…`);
      const queue = getTaskQueue();
      await queue.idle();
      const done = await Promise.all(tasks.map((t) => queue.get(t.id)));
      if (args.json) process.stdout.write(`${JSON.stringify({ tasks: done, skipped }, null, 2)}\n`);
      for (const t of done) {
        if (!t) continue;
        const outcome = t.prUrl ?? t.error ?? t.note ?? t.state;
        log(`${t.task}: ${t.state} — ${outcome}`);
      }
      return done.some((t) => !t || t.state !== "done") ? 1 : 0;
    } catch (error) {
      log(`issues failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "review") {
    try {
      const [{ diffForTarget, parseReviewTarget, reviewDiff }, path] = await Promise.all([
        import("@/lib/review"),
        import("node:path"),
      ]);
      const root = path.resolve(args.repo);
      const target = parseReviewTarget(args.pr ? { prUrl: args.pr } : args.base ? { base: args.base } : "working");
      const diff = await diffForTarget(root, target);
      if (!diff.trim()) {
        log("nothing to review: no changes");
        return 0;
      }
      const result = await reviewDiff({ diff, model: args.model, ...(args.pr ? {} : { root }) });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`${result.summary}\neffort ${result.effort}/5  tests: ${result.tests}\n`);
        for (const f of result.findings) {
          process.stdout.write(`[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}  ${f.title}\n  ${f.detail}\n`);
        }
        if (result.security) process.stdout.write(`security: ${result.security}\n`);
      }
      return 0;
    } catch (error) {
      log(`review failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "clone") {
    const { cloneToWorkspace } = await import("@/lib/workspace/clone");
    try {
      const result = await cloneToWorkspace(args.url, {
        ref: args.ref,
        depth: args.depth,
        setup: args.setup,
        allowLocal: true,
        onProgress: log,
      });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`${result.rootPath}\n`);
        if (result.issue) process.stdout.write(`issue: ${result.issue.title}\n`);
      }
      return 0;
    } catch (error) {
      log(`clone failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  const { runEval } = await import("@/eval/run");
  const summary = await runEval({
    only: args.only,
    model: args.model,
    maxTurns: args.maxTurns,
    timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
    log,
  });
  return summary.resolved === summary.total ? 0 : 1;
}
