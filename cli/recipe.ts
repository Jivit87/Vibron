/**
 * `viberon recipe list|show|validate|run|import`.
 *
 * `run` goes through `runHeadless` with the recipe as its solve function,
 * so a recipe run gets the same evidence bundle, worktree mode and exit
 * codes as `viberon run`.
 */

import path from "node:path";

import type { RecipeArgs } from "./viberon";
import type { HeadlessDeps } from "@/lib/headless/run";
import type { RecipeDeps, RecipeRunResult } from "@/lib/recipes/run";
import type { RecipeEntry, RecipeIssue } from "@/lib/recipes/types";

export interface RecipeCliDeps {
  fetchImpl?: typeof fetch;
  recipe?: RecipeDeps;
  headless?: HeadlessDeps;
  out?: (text: string) => void;
}

function printIssues(issues: RecipeIssue[], write: (text: string) => void, formatIssue: (i: RecipeIssue) => string) {
  for (const issue of issues) write(`  ${formatIssue(issue)}\n`);
}

function describeEntry(entry: RecipeEntry): string {
  const where = entry.source === "builtin" ? "builtin" : `${entry.source}: ${entry.path}`;
  const hidden = entry.shadows?.length ? `  (overrides ${entry.shadows.join(", ")})` : "";
  if (!entry.recipe) return `${entry.name}  INVALID (${entry.errors?.length ?? 0} problem(s))  [${where}]${hidden}`;
  return `${entry.name}  v${entry.recipe.version}  ${entry.recipe.description}  [${where}]${hidden}`;
}

export async function runRecipeCommand(args: RecipeArgs, log: (line: string) => void, deps: RecipeCliDeps = {}): Promise<number> {
  const write = deps.out ?? ((text: string) => void process.stdout.write(text));
  const [store, types] = await Promise.all([import("@/lib/recipes/store"), import("@/lib/recipes/types")]);
  const { formatIssue } = types;
  const repoRoot = args.repo ? path.resolve(args.repo) : args.action === "import" ? null : process.cwd();

  try {
    if (args.action === "list") {
      const entries = await store.listRecipes(repoRoot);
      if (args.json) write(`${JSON.stringify(entries, null, 2)}\n`);
      else for (const entry of entries) write(`${describeEntry(entry)}\n`);
      return 0;
    }

    if (args.action === "show" || args.action === "validate") {
      const entry = await store.findRecipe(args.target!, repoRoot);
      if (!entry) {
        log(`no recipe named "${args.target}"`);
        return 2;
      }
      if (args.action === "show") {
        const source = await store.recipeSourceText(entry);
        if (args.json) write(`${JSON.stringify({ ...entry, text: source }, null, 2)}\n`);
        else {
          write(source.endsWith("\n") ? source : `${source}\n`);
          if (entry.errors?.length) {
            log(`this recipe is invalid:`);
            printIssues(entry.errors, (t) => log(t.trimEnd()), formatIssue);
          }
        }
        return entry.recipe ? 0 : 1;
      }
      if (args.json) write(`${JSON.stringify({ ok: Boolean(entry.recipe), name: entry.name, source: entry.source, path: entry.path, recipe: entry.recipe, errors: entry.errors ?? [] }, null, 2)}\n`);
      else if (entry.recipe) {
        const r = entry.recipe;
        write(`ok  ${r.name} v${r.version}: ${r.params.length} parameter(s), ${r.steps.length} step(s)\n`);
      } else {
        write(`invalid  ${entry.path ?? entry.name}\n`);
        printIssues(entry.errors ?? [], write, formatIssue);
      }
      return entry.recipe ? 0 : 1;
    }

    if (args.action === "import") {
      const result = await store.importRecipe(args.target!, {
        repoRoot,
        scope: args.global || !repoRoot ? "global" : "repo",
        force: args.force,
        fetchImpl: deps.fetchImpl,
      });
      write(
        result.written
          ? `imported ${result.recipe.name} v${result.recipe.version} → ${result.path}\n`
          : `${result.recipe.name} v${result.recipe.version} is already up to date at ${result.path}\n`,
      );
      return 0;
    }

    // run
    const [{ resolveParams }, { recipeSolver, describeInvocation }, { runHeadless }] = await Promise.all([
      import("@/lib/recipes/schema"),
      import("@/lib/recipes/run"),
      import("@/lib/headless/run"),
    ]);
    const { recipe } = await store.loadRecipe(args.target!, repoRoot);
    const { values, issues } = resolveParams(recipe, args.params);
    if (issues.length) {
      log(`recipe ${recipe.name}: invalid parameters`);
      printIssues(issues, (t) => log(t.trimEnd()), formatIssue);
      return 2;
    }
    let run: RecipeRunResult | null = null;
    const outcome = await runHeadless(
      {
        repo: repoRoot ?? process.cwd(),
        task: describeInvocation(recipe, values),
        worktree: args.worktree,
        keepWorktree: args.keepWorktree,
        out: args.out,
        maxTurns: args.maxTurns,
        timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
        model: args.model,
        log,
      },
      {
        ...deps.headless,
        solve: recipeSolver(recipe, values, {
          // Without --allow-commands only auto-approved commands run: nobody is there to ask.
          commandPolicy: args.allowCommands ? "auto" : "ask",
          deps: deps.recipe,
          onResult: (result) => {
            run = result;
          },
        }),
      },
    );
    if (args.json) {
      write(`${JSON.stringify({ ...outcome.result, recipe: { name: recipe.name, version: recipe.version, params: values, steps: (run as RecipeRunResult | null)?.steps ?? [] } }, null, 2)}\n`);
    } else {
      const steps = (run as RecipeRunResult | null)?.steps ?? [];
      for (const s of steps) {
        const mark = s.status === "succeeded" ? "ok     " : s.status === "failed" ? "FAILED " : "skipped";
        write(`${mark}  ${s.id}  ${s.title}${s.error ? `  — ${s.error.split("\n")[0]}` : ""}\n`);
      }
      const r = outcome.result;
      write(
        `${r.status.toUpperCase()}  ${r.filesChanged.length} file(s) changed  ${r.metrics.modelCalls} model calls  ` +
          `${(r.metrics.inputTokens + r.metrics.outputTokens).toLocaleString()} tokens  ${(r.metrics.durationMs / 1000).toFixed(0)}s\n` +
          `${r.error ? `error: ${r.error}\n` : ""}evidence: ${outcome.outDir}\n`,
      );
    }
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof store.RecipeError) {
      log(error.message);
      printIssues(error.issues, (t) => log(t.trimEnd()), formatIssue);
      return error.issues.length ? 1 : 2;
    }
    log(`recipe ${args.action} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
