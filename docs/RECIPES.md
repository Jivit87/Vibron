# Recipes: shareable YAML workflows (Task 3.1)

## Problem

Useful agent workflows get retyped as prompts every time: "write tests for this file, run them, fix them if they fail", "upgrade X and adapt the code if the checks break". A prompt cannot say "run the linter first", "only fix if the check failed", or "this file is yours and nothing else". It cannot be versioned, reviewed or shared either.

A **recipe** is a small YAML file that captures such a workflow: typed parameters, then an ordered list of steps. Each step is an agent prompt, a shell command, or a verification check. The file is the unit of sharing: commit it, send it, or import it from a URL.

## Design

```
.viberon/recipes/<name>.yaml ─┐
~/Viberon/recipes/<name>.yaml ├─► store (lookup by name) ─► yaml.ts (strict subset) ─► schema.ts (typed Recipe, line-numbered issues)
built-in examples ────────────┘                                                              │
                                                  params ─► resolveParams (coerce, defaults, required, path safety)
                                                                                             ▼
                                  recipeSolver: SolveOptions → SolveResult   (snapshot → executeRecipe → diff)
                                           │                      │
                     CLI: runHeadless (evidence bundle)    API: POST /api/recipes/run (SSE)
```

| File | Job |
|---|---|
| `lib/recipes/yaml.ts` | Strict YAML-subset parser with node → line map |
| `lib/recipes/schema.ts` | Validation into `Recipe`, parameter coercion (`resolveParams`) |
| `lib/recipes/expr.ts` | `{{ }}` templates (shell-quoted in shell contexts) and `when:` conditions |
| `lib/recipes/store.ts` | Repo, global and built-in lookup; https/file import |
| `lib/recipes/builtin.ts` | The four example recipes, as YAML text |
| `lib/recipes/run.ts` | `executeRecipe`, `recipeSolver`, `recipePlan` |
| `cli/recipe.ts` | `viberon recipe …` |
| `app/api/recipes/route.ts`, `app/api/recipes/run/route.ts` | List/show/validate, run (SSE) |
| `components/vibe/RecipeDialog.tsx`, `lib/client/recipes.ts` | Picker and parameter form |

### Execution reuses the existing paths

There is no second engine. A recipe is a fixed plan, and each step goes through what the rest of Viberon already uses:

- **agent** steps call `runAgent` exactly as the orchestrator runs a plan step. They use the same `buildStepTask` framing and the owned files as the write lock (`writeScope`). `tools` narrows the role's tool list. Memory and the context engine are refreshed before each step, as between the orchestrator's waves. With `role: solver` the step runs `solveTask` instead, with localization, the verification gate and a retry.
- **shell** steps run in the terminal (`runCommand`, repo environment, scrubbed secrets, process groups). Before that they pass the same check `run_command` applies: `classifyCommand` (the hard blocklist, then the auto-approve list), then the command policy, then the run's approval channel.
- **verify** steps use `lib/verify`: the repository's detected checks (optionally one `kind`, optionally `targets`), or a custom command that is policy-checked like a shell step. Outcomes are parsed per test.

Progress is the ordinary `OrchestrationEvent` stream. The recipe arrives as a `plan`, and each step gets a wave and a lane (agent lanes as usual; shell steps as `devops`, verify steps as `tester`). Commands and checks arrive as `command` and `verification` events, and the stream ends with `run_done`. The run view, the SSE transport and the headless `trajectory.jsonl` therefore need nothing recipe-specific. A solver step's own `run_start`/`run_done` are filtered out of the recipe's stream.

`recipeSolver` adapts a recipe to the `SolveOptions → SolveResult` contract. The CLI passes it to `runHeadless` as its `solve`, so `recipe run` gets the same features as `viberon run`: `--worktree`, `result.json`, `patch.diff`, `report.md` and the same exit codes. The status maps as follows:

| Recipe outcome | Status | Exit |
|---|---|---|
| all steps ok, and a verify step passed after the last agent/shell step | `resolved` | 0 |
| all steps ok, but no verification after the last change | `unverified` | 0 |
| a step failed without `continue_on_error` | `failed` | 1 |
| stopped | `incomplete` | 1 |

## Format

```yaml
name: add-tests                 # lowercase, digits, -; must match the file name
description: Add unit tests for a source file, then prove they pass
version: 1.0.0                  # 1, 1.2, 1.2.3 (optionally -pre/+build)
author: You                     # optional

params:
  file:
    type: path                  # string | number | boolean | enum | path
    required: true
    description: Source file to cover
  focus:
    type: string
    default: edge cases
  framework: string             # shorthand: just the type

steps:
  - id: write                   # optional; default step-N
    title: Write tests for {{file}}
    agent:
      role: tester              # any roster role except orchestrator; default generalist
      tools: [read_file, write_file, run_command]   # optional subset of the role's tools
      files: ["tests/**"]       # owned files = write lock (paths, dir/**, globs)
      max_turns: 20
      prompt: |
        Write tests for `{{file}}`, covering {{focus}}.
  - id: check
    verify:                     # or `verify: auto`
      kind: test                # test | typecheck | compile | lint
      targets: [tests/a.test.ts]
      # command: npm test       # instead of auto-detection
    continue_on_error: true
  - id: repair
    when: check.failed
    agent: |
      The tests fail:
      {{steps.check.output}}
  - shell: npx eslint {{file}}
    timeout: 300                # seconds, shell and verify steps only
```

- **Templates.** `{{name}}` is a parameter and `{{steps.<id>.output}}` is an earlier step's output: the agent's summary, or the condensed command/check output, capped at 8,000 characters. `\{{` is a literal `{{`. In `shell:` and `verify.command` every substituted value is **shell-quoted**. Simple words such as paths stay bare.
- **Conditions.** `when:` accepts:
  - `<step>.succeeded | failed | skipped | ran`
  - `params.<name>`, and `==` / `!=` against string, number or boolean literals
  - `!`, `&&`, `||`, parentheses
  - `always`, `success` (nothing has failed yet), `failure`

  Conditions may only name earlier steps and declared parameters.
- **Flow.** A step with no `when` runs only while the recipe has not failed. A step *with* `when` runs exactly when the condition holds, so `when: check.failed` works as an error handler. A failed step with `continue_on_error: true` is recorded (conditions see it as `failed`), but it does not fail the recipe. The usual pattern is *check (continue) → fix (when failed) → re-check (when failed)*: the re-check decides the outcome.

### The YAML subset

No YAML parser is a direct dependency (`js-yaml` is only transitive), so `lib/recipes/yaml.ts` implements what recipes need:

- **Supported:**
  - block mappings and sequences, including compact `- key: v` items;
  - plain, single-quoted and double-quoted scalars, with escapes;
  - one-line flow `[…]` and `{…}`;
  - `|` and `>` block scalars with `-`/`+` chomping and an indentation digit;
  - `#` comments and one leading `---`.
- **Rejected with a line-numbered message:**
  - anchors, aliases, tags, directives, complex keys and merge keys;
  - multiple documents;
  - tabs in indentation;
  - duplicate keys;
  - multi-line plain or quoted scalars ("use | or >");
  - multi-line flow collections;
  - a value starting with `{{` unquoted, which YAML would read as a flow mapping.

Plain scalars resolve like YAML 1.2's core schema, so `yes` is a string, not `true`. Files are capped at 256 KB and nesting at 32 levels. The parser was differential-checked against js-yaml on the supported subset.

Schema validation reports *every* problem at once, each with its path and line, for example:

```
line 15: steps[2].agent.role: unknown role "wizard" (one of: assistant, architect, …)
line 20: steps[3].agent.tools[0]: "write_file" is not one of the reviewer role's tools (…)
line 23: steps[4].when: "missing" is not an earlier step (earlier: one, three)
```

## Using it

**Where recipes live.** Lookup goes in this order, and the first match wins:

1. `<repo>/.viberon/recipes/<name>.yaml`
2. `$VIBERON_RECIPES_DIR` or `~/Viberon/recipes/`
3. the built-ins

A repository recipe can therefore override a shared one. Note that `.viberon/` is git-excluded locally, so to commit a recipe use `git add -f .viberon/recipes/x.yaml`.

**Built-ins:**

| Recipe | What it does |
|---|---|
| `add-tests` | `file`, `focus`: a tester writes tests → run the tests → repair if they fail → re-run |
| `fix-lint` | `linter` (eslint/ruff), `path`: lint → fix what it reports → lint again |
| `bump-dependency` | `package`, `version`, `manager` (npm/pnpm/yarn): install → checks → adapt the code if they break → checks |
| `document-module` | `module`, `audience`: a docs agent that owns only that file adds doc comments → checks prove behaviour is unchanged |

**CLI:**

```
viberon recipe list [--repo .] [--json]
viberon recipe show add-tests                 # prints the YAML: fork it by saving it
viberon recipe validate ./my-recipe.yaml      # exit 0 valid, 1 invalid
viberon recipe run add-tests --param file=src/slug.ts --repo . [--worktree] [--allow-commands] [--json]
viberon recipe import https://github.com/acme/recipes/blob/main/triage.yaml [--repo . | --global] [--force]
```

**API.** The routes below mirror the CLI; the run route streams SSE.

- `GET /api/recipes?repoKey=` returns `{recipes}`.
- `GET /api/recipes?repoKey=&name=` returns `{entry, text}`.
- `POST /api/recipes` validates:
  - with `{source}`, the YAML text;
  - with `{repoKey, name, params}`, a saved recipe and the values a run would get.

  It returns `{ok, recipe?, errors[]}`.
- `POST /api/recipes/run {repoKey, name, params, model, commandPolicy, editPolicy}` streams the run as SSE. The run id is in `X-Run-Id`, and Stop and approvals use `/api/agent/cancel` and `/api/agent/approve`. Before any stream opens, bad input is answered with `400` (bad params), `404` (unknown recipe) or `422` (invalid recipe).

**UI.** Open the picker in any of these ways:

- type `/recipe` in the composer (a slash suggestion appears);
- type `/recipe add-tests file=src/a.ts`, which opens the picker with those values prefilled;
- choose **Run recipe…** in the command palette (⌘K).

Pick a recipe, fill its typed form (path fields autocomplete from the workspace), and Run. The parameters are validated server-side first. Invalid recipes are listed with their line-numbered errors. The run streams into the normal run view, with an automatic checkpoint for one-click undo.

## Decisions and trade-offs

- **A strict subset instead of a dependency.** Adding a YAML package for ~5% of YAML is not worth it, and permissive YAML is a liability in a shared, executable file (anchors, "Norway problem" booleans, silent folding). Anything outside the subset is an error with a line number, never a guess.
- **Validation at load time.** Unknown keys, unknown roles, tools outside a role, templates or conditions naming undeclared parameters or later steps are all load errors. The alternative is failing halfway through a run that has already edited files.
- **Sequential steps.** The orchestrator's parallel waves exist to split *one* request. A recipe is an explicit procedure whose steps depend on earlier outcomes, so it runs in order. Each step is still a normal lane with a write lock.
- **Recipe-level status versus the gate.** `resolved` requires a verify step to pass after the last change. A recipe that only edits or only runs commands is `unverified`, following the harness rule that tests judge.
- **No MCP servers in agent steps.** A recipe runs exactly the tools it declares (`mcp: false`), as headless solves do.

## Security

- **Commands.**
  - Every shell step and custom verify command goes through `classifyCommand`. Blocked commands (`rm -rf ~`, `curl … | sh`, privilege escalation…) never run, whatever the policy.
  - Commands off the auto-approve list follow the policy:
    - `auto` runs them;
    - `ask` routes them to the run's approval card in the app, and refuses them when nobody can answer;
    - `never` refuses everything.
  - The CLI defaults to `ask` with no approver: only safe-list commands run unless `--allow-commands` is given.
  - Commands run with the terminal's scrubbed environment, so no API keys reach them.
- **Injection.** Parameter values and step outputs are shell-quoted wherever they are substituted into a command. A `path` parameter must be relative, contain no `..` and not be absolute or `~`. The same applies to rendered owned files and verify targets.
- **Agents.** Agent steps keep the role's least privilege: `tools` can only narrow the role's list, never widen it. `files` becomes an enforced write scope, and repository content stays framed as untrusted data.
- **Import.** Only `https://` URLs are fetched:
  - URLs with embedded credentials are refused;
  - a redirect to a non-https URL is refused;
  - the download is capped at 64 KB (both by `Content-Length` and while streaming) and times out after 15 s.

  The recipe is validated **before** anything is written, it is saved verbatim under its own name, and an existing different file is only replaced with `--force`. Importing only saves the recipe; nothing runs until someone runs it.
- **API.** Routes accept recipe *names* only (`^[a-z0-9][a-z0-9-]*$`), never paths, so the API cannot be used to read arbitrary files. Validation input is capped at 256 KB.
- **Review before running.** A recipe from someone else is code. `recipe show` / `validate` print exactly what it will do, and a run starts with a checkpoint (UI) or can use `--worktree` (CLI).
