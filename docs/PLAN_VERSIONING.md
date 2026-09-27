# Plan versioning and experiment branching

Every plan the orchestrator makes is now kept as an immutable version you can look back at, compare, edit and run again. A task can also be forked into experiment branches. Each branch runs a different model, prompt or plan in its own git worktree, and the harness scores the branches on its own evidence so you can promote the best one.

The design rule still holds: the model proposes, the harness decides, and tests judge. The branches are compared on what the gate measured, not on what the models claimed.

## The problem

- **Plans were throwaway.** The orchestrator turned a request into a task DAG, ran it and forgot it. When a run went badly, there was no record of the plan behind it, no way to see how an edited plan differed from the original, and no way to run the same plan again with another model.
- **There was no way to compare approaches fairly.** Asking "would Sonnet do this as well as Opus?" or "is the three-step plan better than the one-step plan?" meant running the task twice in the same checkout, which is slow and destroys the first result. Judging the answers took guesswork.

## Plan versions

### What is stored

Versions live in `<workspace>/.viberon/plans/`, which is git-excluded like the rest of `.viberon/`:

```
versions/<id>.json   one PlanVersion per file, written once
runs/<id>.jsonl      one PlanRunOutcome per line, appended after each run
```

A **PlanVersion** holds:

- `id` (`pv_<time>_<random>`) and `parentId`;
- `origin`: `planned`, `edited`, `replan` or `experiment`;
- `prompt`, the request the plan answers;
- `plan`, the DAG: each step's id (the owner of its files), title, role, detail, `files` (its write lock) and `dependsOn`, plus the waves;
- `model`, `createdAt`, the `runId` that produced it, and an optional `note`;
- `hash`, a sha256 of the prompt and the canonical steps.

A **PlanRunOutcome** holds the run id, status, model, timing, files changed, cost, tokens, the outcome of each step (`done`, `failed`, `skipped` or `not_run`), the number of forced re-plans, and the experiment branch when there is one.

### Immutability

A version never changes:

- It is written with exclusive create (`wx`) in read-only mode, so an existing id cannot be overwritten.
- Its hash is checked on every read. A file edited by hand is refused (`modified`), and the list shows it as `intact: false`.
- `commit()` re-derives the hash, so a record whose hash does not match its content cannot be stored.
- Editing a plan makes a new version whose `parentId` points at the old one. Running a version only appends to its run log.

### How versions are made

The **plan recorder** (`lib/plans/recorder.ts`) wraps the orchestrator's event stream. Because it works on the stream rather than inside the planner, every path that shows or runs a plan is versioned the same way:

| Situation | Result |
|---|---|
| The planner produces a plan (Agent or Plan mode) | a new `planned` version |
| You approve a plan-mode plan unchanged | the run is recorded on that same version |
| You edit it first | a new `edited` version with the original as parent |
| A second `plan` event arrives in the same run (a re-plan after recovery) | a new `replan` version, child of the current one |
| An experiment branch uses a changed plan or prompt | a new `experiment` version |

The `plan` event now carries `versionId` and `parentVersionId`, so the UI always knows which version it is showing. Recovery `replan` events are counted on the run's outcome.

Today the orchestrator emits one plan per run, and the single-agent solver's forced re-plan is a prompt nudge rather than a new DAG. That nudge is counted as `replans` on the outcome. Any future path that emits a revised `plan` event is versioned as a `replan` automatically.

`emit` is synchronous, so the recorder mints the version id straight away and queues the file write. The orchestrator waits for the queue (`flush()`) before it returns. A failed write becomes one non-fatal `error` event and never fails the run.

### Structural diff

`diffPlans(a, b)` (`lib/plans/diff.ts`) compares two versions (or two raw plans):

- It matches steps **by id**, then pairs any leftovers **by title**, so renaming a step's id reads as one changed step rather than a removal plus an addition.
- `added`, `removed` and `changed` steps. Each change lists its fields (`title`, `role`, `detail`, `files`, `dependsOn`) and the files and dependencies added and removed.
- `ownership`: each file whose owning step changed, from A's owner to B's. A rename alone is not reported as an ownership change.
- `reordered`, `wavesChanged`, `summaryChanged`, `promptChanged` and `modelChanged`.
- `identical`: nothing structural differs. A version that differs only in its model counts as identical, with `modelChanged` set.

### Edit and re-run

Plan mode already let you review and edit a plan before running it. It now also works on stored versions:

- **Edit** opens the version in the run view's plan review, exactly as plan mode shows it. **Run plan** sends the plan with its `planVersionId`. The server runs it as that version if it is unchanged, and saves it as a child version if you edited it.
- **Re-run** runs the version as it is. The run is recorded on the same version.

## Experiments

### Flow

```
source ──► base tree ──► branch b1: worktree ─► solve / orchestrate ─► gate ─► evidence ─┐
(workspace│plan│          branch b2: worktree ─► …                                        ├─► rank ─► promote │ discard
 checkpoint│ref)          branch bN (≤ concurrency at once)                                ┘
```

1. **Source → base tree.** Every source is turned into one git tree:
   - `workspace` and `plan`: a snapshot of the work tree as it is now, including uncommitted and untracked files. This uses the harness's private-index `snapshot()`, so your index is not touched.
   - `ref`: any commit or tree, such as a checkpoint event's `ref`.
   - `checkpoint`: a Changes-panel checkpoint. Its files are written into a scratch worktree of HEAD using the same rules as a restore (files created since the checkpoint are deleted), and that worktree is snapshotted.
2. **Variants → branches.** A variant sets any of `model`, `prompt`, `plan` (an edited plan) and `planVersionId`.
   - With a plan (from the source or the variant), the branch runs in **plan mode**. The plan and prompt are saved as an `experiment` version. If they are unchanged, the source version is reused.
   - Otherwise the branch runs in **solve mode**.
   - An experiment has 1 to 8 branches.
3. **Isolation.** Each branch goes through `runHeadless` with `--worktree`, the same machinery as `viberon run --worktree`:
   - The branch gets a detached `git worktree` in a fresh temporary directory. `createWorktree` now takes a `baseTree`, applied with `git read-tree -u --reset`.
   - Git-ignored dependency directories (`node_modules`, `.venv`, `venv`) are symlinked in so the checks can run.
   - Branches never share a directory, and the main checkout is never written to.
4. **Execution.**
   - **Solve mode** runs `solveTask`, the full harness: localization, the solver loop, the gate and a second attempt.
   - **Plan mode** runs the orchestrator on the plan's DAG, with file locks, waves and specialists. The harness's `Gate` then gives a final ruling on the original and patched code (`lib/experiments/plan-solve.ts`), and the result is mapped to a status on the same ladder `solveTask` uses. Both modes therefore produce a `SolveResult` and compare fairly.
   - The run's outcome is recorded on its plan version, tagged with the experiment and branch.
5. **Concurrency.** Branches run in a worker pool bounded by `concurrency`: 2 by default, at most 4.
6. **Evidence.** Each branch leaves the usual bundle in `.viberon/experiments/<id>/<branch>/`: `result.json`, `patch.diff`, `report.md` and `trajectory.jsonl`. `experiment.json` holds the record. It is rewritten atomically after every branch.

### Scoring and ranking

Branches are ranked **lexicographically**, most important first:

1. **Verdict:** resolved > unverified > incomplete > failed > error.
2. **Regressions:** fewer tests broken.
3. **Tests fixed:** more is better.
4. **Diff size:** fewer changed lines.
5. **Cost**, then 6. **tokens**, then 7. **time**.

A strict order is easier to defend than a weighted sum. No amount of saved tokens should outrank a regression, and a proven fix should always beat an unproven one. A `value` number folds the same order together for display.

The **winner** is the top branch, but only if it changed something and broke nothing. Otherwise there is no winner, and the CLI exits 1.

### Promote, undo and discard

- **Promote** applies the branch's `patch.diff` to the main work tree:
  1. The patch is checked with `git apply --check` before anything is written.
  2. The workspace is snapshotted (`beforeTree`).
  3. In the IDE, a Changes-panel checkpoint is also taken.
  4. The patch is applied to the **work tree only**. The index, HEAD and branches are untouched.

  If the patch no longer applies because the workspace changed since the fork, promotion is refused with 409 `conflict` and nothing changes. Only one branch can be promoted at a time.
- **Undo** depends on what happened after the promotion:
  - If the workspace is exactly as the promotion left it (`afterTree`), it is restored to `beforeTree`.
  - Otherwise only the branch's patch is reversed, so edits made after the promotion survive.
  - A patch that no longer reverses cleanly is refused, and the error names the checkpoint to restore instead.
- **Discard** stops a running experiment (every branch's solve is aborted), then removes every branch worktree and prunes git's worktree list. Evidence bundles are kept unless you pass `purge`. A promoted patch stays in place; undo it separately.

## How to use it

### IDE

Open the **Plans & Experiments** view (the fork icon in the activity bar, next to Agent Changes, or "Plans & experiments" in the command palette).

- **Versions** lists every version with its origin, size, age and last run.
  - Expand a version to see its steps, lineage and runs, with **Edit**, **Re-run** and **Experiment** buttons.
  - Tick two versions to see their structural diff.
- **Experiments** holds a form: the task, models (one branch each; click a configured model to add it), optional prompt variants (one per line, crossed with the models) and the number of branches to run at once.
  - Starting from a version's **Experiment** button forks from that plan.
  - While an experiment runs, its card updates live.
  - The comparison table shows rank, verdict, tests fixed and broken, diff size, tokens, cost and time. Click a branch to see its patch.
  - **Promote** and **Undo** are on each row. **Discard** is on the card.

### CLI

```
viberon plan list [--repo <path>] [--json]
viberon plan show <id> [--repo <path>] [--json]
viberon plan diff <a> <b> [--repo <path>] [--json]

viberon experiment run --repo <path> (--task <text> | --plan <id>)
    [--variants models=a,b[;plans=<id>,<id>]] [--prompts-file <file>]
    [--concurrency n] [--from-ref <ref>] [--max-turns n] [--timeout sec]
    [--test-cmd cmd] [--no-gate] [--keep-worktrees] [--json]
viberon experiment list|show <id>|promote <id> <branch>|undo <id>|discard <id> [--purge]
```

`experiment run` prints the comparison table, writes `comparison.json` next to the record, and prints the promote command for the winner. With `--json` it prints `{experiment, comparison}` instead. It exits 0 when there is a winner, 1 when there is none, and 2 on error.

The CLI removes each worktree as soon as its branch finishes unless you pass `--keep-worktrees`. Promotion only needs the stored patch.

### API

| Route | Purpose |
|---|---|
| `GET /api/plans?repoKey=` | list versions |
| `GET /api/plans/:id?repoKey=` | a version, its outcomes, lineage and children |
| `GET /api/plans/diff?repoKey=&a=&b=` | structural diff |
| `POST /api/plans/:id/rerun {repoKey, model?, commandPolicy?, …}` | SSE, the same stream and run registry as `/api/agent` |
| `POST /api/agent {…, plan, planVersionId}` | run an approved plan as (or as a child of) a version |
| `GET /api/experiments?repoKey=` | list |
| `POST /api/experiments {repoKey, task?, source?, variants, concurrency?, maxTurns?, timeoutSec?, testCmd?, noGate?}` | create (201) and run in the background |
| `GET /api/experiments/:id?repoKey=` | status and comparison, plus `active` |
| `GET /api/experiments/:id/events?repoKey=` | SSE of `ExperimentEvent`s: replay, then the live tail |
| `GET /api/experiments/:id/compare?repoKey=[&patches=1]` | ranked rows, with each branch's patch if asked |
| `POST /api/experiments/:id/promote {repoKey, branchId}` / `{repoKey, undo: true}` | promote or undo |
| `POST /api/experiments/:id/discard {repoKey, purge?}` | discard |

## Decisions and trade-offs

- **Versions are hooked on the event stream, not on the planner.** A single seam covers fresh plans, plan mode, approvals, edits, re-runs and future re-plans, and the orchestrator stays free of storage concerns.
- **Content-addressed dedupe.** Re-running an unchanged plan is not a new version. The hash covers the prompt and the steps but not the model, because the model is a property of a run.
- **Files on disk, not the app store.** Versions and experiments belong to the repository: they survive restarts, the CLI and the desktop app share them, and they sit beside the other `.viberon/` state. Workspaces that exist only in the app store (no folder on disk) have no plan versions.
- **Reuse `runHeadless` for branches.** Branches get the same evidence bundle, hooks with trust taken from the source repo, and verification detection as `viberon run`. The new options (`worktreeOptions`, `onEvent`, `recordMemory`, `embedded`) keep it usable inside the app server. `embedded` stops it from switching the app's store to memory mode.
- **Plan branches are judged by the gate too.** The orchestrator has no gate of its own, so a plan branch runs the orchestrator and then the harness's `Gate` on the result. Without that, a plan branch and a solve branch could not be ranked on the same evidence.
- **Fork from a snapshot, not HEAD.** Uncommitted work is part of what you are experimenting on. Forking from HEAD would also make patches fail to apply on promotion.
- **Symlinked dependencies.** Without them most JS and Python repositories cannot run their tests in a fresh worktree. They are git-ignored, so they never enter a snapshot or a patch. The trade-off: a branch that runs `npm install` writes into the shared directory. That is why only well-known dependency directories are linked.
- **Experiments do not go through the task queue.** The task queue deliberately runs one task per repo, while experiments need bounded parallelism across isolated worktrees. The experiment has its own pool, and the IDE follows it with the task queue's replay-then-tail SSE pattern.

## Security

- **Isolation.** Branches run in worktrees under the system temp directory, and nothing is written to your checkout until you promote. Promotion only touches the work tree, is checked before it applies, and can be undone.
- **Path safety.**
  - Version and experiment ids are pattern-checked before they become paths, and branch ids must be `b<n>`.
  - Discard only deletes a directory the experiment created: `<tmp>/viberon-wt-*/<id>-<branch>`.
  - `removeWorktree` never deletes a directory outside a `viberon-wt-*` parent.
  - A checkpoint's files are written only inside the scratch worktree.
- **Git arguments.** A `ref` source must match a conservative pattern and may not start with `-`, so it cannot become an option such as `--upload-pack`. Patches reach `git apply` on stdin.
- **Secrets.** Branches inherit the harness's scrubbed verification environment. Git-ignored files other than dependency directories, such as `.env`, are not copied into branch worktrees.
- **Hooks.** Branch runs load hooks with trust taken from the source repository (the `--worktree` rule), so an untrusted workspace hooks file does not run in its branches either.
- **Untrusted input.** Every route re-validates its body: variants are capped at 8, sizes are capped, plans are re-normalized (roles, file locks and waves are re-derived), and concurrency is clamped to 4.
- **Tamper evidence.** A plan version edited on disk fails its hash check, is refused for re-runs, and is flagged in the list.

## Limits

- Plan branches run the orchestrator's agents with `commandPolicy: "auto"`, as headless solves do. The terminal policy's classifier still applies, but nothing asks for approval inside a branch.
- Branch tokens, cost and model calls come from the orchestrator's ledger for plan branches and from the solver's metrics for solve branches. Both come from the same provider accounting, but plan branches count one model call per specialist lane.
- A checkpoint source needs the app store (the IDE). The CLI uses `--from-ref` instead.
- Worktrees live in the system temp directory until they are discarded. An experiment interrupted by a restart is shown as `interrupted`, and **Discard** still cleans it up.
