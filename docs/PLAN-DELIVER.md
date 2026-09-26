# Round 4, wave 2: review, deliver, CI (the issue → PR loop)

Wave 1 (`PLAN-SOLVE.md`) makes Viberon **solve and prove** a fix. Wave 2 makes it **ship** the fix and **review** code, borrowing only mechanisms that work in a local, single-user desktop harness. Everything here runs on the GitHub token already stored by the GitHub integration (`readGithubEntry((await getGlobalEntries()).github)?.token`, falling back to `GITHUB_TOKEN`). Nothing is pushed, posted or opened without an explicit click.

## What we take, and what we leave

| Source | Take | Leave (and why) |
|---|---|---|
| **PR-Agent** (The-PR-Agent/pr-agent) | Single-call tools `review`, `describe` and `improve`. **Diff compression:** drop delete-only hunks, sort files by language, then by size, pack to a soft/hard token budget, list the files that did not fit. Structured output validated against a schema. **Self-reflection:** a second cheap call scores each suggestion 0–10 and drops those below a threshold. Findings capped (`num_max_findings`, default 3), with security and tests sections | GitLab/Bitbucket/Azure providers, LiteLLM, labels, changelog and docs tools (not needed; we have our own provider layer) |
| **Open SWE** (langchain-ai/open-swe) | The **deliver loop:** validate → commit → branch → push → open/update PR. A **thread = workspace + branch**, so a follow-up continues the same branch. `/baby-sit`: watch PR checks, pull failing job logs, and either **fix** (a new solve run seeded with the extracted failures) or **re-run only evidence-backed flaky jobs** (max 3 per head sha). **Analyzer:** learn a repo's review style from past review comments | LangGraph runtime, cloud sandboxes, Slack/Linear, multi-tenant auth (we are local and single-user; worktrees are our isolation) |
| **Jiffy gateway** (Jiffy-Agnet/gateway) | **Task queue** with traceable states (queued → running → done/failed), one worker per repo. **Branch names from the task title** (`viberon/<slug>`). A **report comment back on the issue** with the PR link and evidence. **Channel-agnostic intake:** a local `POST /api/tasks` API (their unbuilt "Public API channel"), and the UI and CLI enqueue through the same queue | Django, Celery, Redis, Docker egress sandbox, edge Actions/webhooks (a desktop app cannot receive webhooks; intake is the UI, the CLI and the local API) |

## Contracts

### `lib/github-api.ts` (already on main)
The shared REST client: `parsePrUrl`, `parseRemote`, `getPullRequest`, `getPullRequestDiff`, `findOpenPullRequest`, `createPullRequest`, `updatePullRequest`, `getDefaultBranch`, `listRepoReviewComments`, `createIssueComment`, `listCheckRuns`, `actionsJobId`, `getJobLogs` and `rerunJob`. The token comes from `resolveGithubToken()`, and `fetchImpl` can be injected. Extend it in place; do not add a second client.

### `lib/review` (Executor A)
```ts
compressDiff(diff: string, budgetTokens: number) → { text: string; included: string[]; omitted: string[]; tokens: number }
reviewDiff({ diff, task?, model, signal }) → Review         // 1 call
describeDiff({ diff, task?, model, signal }) → { title: string; body: string; type: "bug" | "feature" | "refactor" | "docs" | "test" | "chore" }  // 1 call
improveDiff({ diff, model, signal, threshold = 7 }) → Suggestion[]  // 2 calls: generate + self-reflect
interface Review { summary: string; effort: 1|2|3|4|5; findings: { file: string; line?: number; severity: "high"|"medium"|"low"; title: string; detail: string }[]; security: string | null; tests: "adequate" | "missing" | "n/a" }
interface Suggestion { file: string; startLine: number; endLine: number; existing: string; improved: string; why: string; score: number }
```
- Uses the provider layer in `lib/ai` with a cheap-tier model by default.
- **The solve loop uses `reviewDiff` as its final reviewer** (Pramana layer 5). A `high` finding sends the attempt back once, with the finding as a hint.
- `POST /api/review { repoKey, target: "working" | "staged" | { base: string } | { prUrl: string }, tool: "review" | "describe" | "improve" }`. A PR URL fetches the diff through the GitHub REST API.

### `lib/deliver` (Executor B)
```ts
branchName(title: string) → string                      // viberon/<slug>, ≤ 48 chars, deduped against existing branches
deliver({ root, title, body, draft = true, baseBranch? }) → { branch, commit, prUrl, prNumber }
reportOnIssue({ issueUrl, prUrl, summary, evidence }) → { commentUrl }
ciStatus({ prUrl }) → { headSha, state: "pending" | "success" | "failure", checks: { name, conclusion, url, logExcerpt? }[] }
rerunFlaky({ prUrl, checkName, evidence }) → { ok } // max 3 per head sha; evidence required
```
- Git runs via the existing `lib/git` (execFile, no shell). The token is passed with `-c http.extraheader=Authorization: basic …`, never embedded in a URL or logged.
- Refuse to deliver if the working tree has changes outside the solve's `filesChanged`, or if `.github/workflows/**` changed (Open SWE's human-approval rule; the UI must re-confirm).
- Routes:
  - `POST /api/deliver`;
  - `POST /api/deliver/report`;
  - `GET /api/ci?prUrl=`;
  - `POST /api/ci/rerun`.
  - "Fix CI" is `POST /api/tasks { kind: "fix", repoKey, task: <extracted failures from lib/verify.extractFailures> }`.

### `lib/tasks`: the queue (Executor B)
```ts
enqueue({ kind: "fix" | "review", repoKey, task, source: "ui" | "cli" | "api" | "issue", issueUrl?, deliver?: boolean }) → Task
interface Task { id; kind; repoKey; task; source; state: "queued" | "running" | "done" | "failed" | "cancelled"; createdAt; startedAt?; finishedAt?; result?: SolveResult | Review; prUrl?; error? }
```
- In-process, persisted in the settings store, **one running task per repo**, FIFO. On restart, `running` becomes `failed ("interrupted")`.
- Routes: `POST /api/tasks`, `GET /api/tasks?repoKey=`, `DELETE /api/tasks/:id` (cancel), and `GET /api/tasks/:id/events` (SSE of the solve events, so the FixRun view can attach to a queued task).
- The CLI gains `viberon review` and a `--deliver` flag.

### Review-style learning (Executor A, P1)
`learnReviewStyle({ repoUrl, limit = 50 })`: fetch recent PR review comments, make one cheap call to extract conventions, and write them as `convention` notes in the Obsidian vault anchored to the paths they mention. `reviewDiff` includes the relevant convention notes.

### FE
- **SCM panel:** "Review", "Describe" and "Improve" on working/staged changes. Findings are rendered inline in the diff view; suggestions apply with one click through the existing edit path.
- **FixRun, after a resolved run:** a "Deliver" bar with the branch name (editable), the PR title and body from `describeDiff` (editable), the draft toggle and "Open PR". Then "Comment on issue" and a CI status strip with **Fix CI** / **Re-run (flaky)** actions.
- A **Tasks panel** listing queue states, attachable to live runs.
- **Command palette:** "Review a GitHub PR…" (paste a URL) and "Learn review style".

## Ownership (unchanged)
A: `lib/review/**` (including review-style learning, which writes convention notes through the `lib/memory/graph` API), the solve-loop reviewer hook, and `app/api/review/**`. B: `lib/deliver/**`, `lib/tasks/**`, `app/api/{deliver,ci,tasks}/**`, the CLI, and additions to `lib/github-api.ts`. FE: UI only.
