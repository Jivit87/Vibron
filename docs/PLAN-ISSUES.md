# Issues → fix → pull request

The user's request: *Viberon reads the repo's GitHub issues, fixes them, and opens pull requests.*

Everything below the queue already exists: `solveTask` (reproduce → fix → prove), `deliver` (branch → commit → push → draft PR), `reportOnIssue` (a comment with the evidence) and the task queue. This round adds the missing top of the pipeline.

```
GitHub issues ─▶ list (labels) ─▶ enqueue fix+deliver ─▶ clean base (origin/<default>) ─▶ solve with the issue text
                                                                      ─▶ resolved? ─▶ draft PR "Fixes #N" ─▶ comment on the issue
auto mode: a poller picks up issues carrying the trigger label (default `viberon`)
```

## Rules
- **The issue text is untrusted.** The title, body and up to 20 comments reach the solver inside an explicit "untrusted issue" frame. Only `resolved` fixes (strong evidence) are delivered; anything else stays local, with a note.
- **Every issue starts from a clean base.** The work tree must be clean. The harness fetches `origin/<default branch>` and checks it out detached, so each PR contains exactly one fix.
- **The label is the trust gate for auto mode.** On GitHub only people with triage rights can apply labels, so an issue carrying the trigger label was approved by a maintainer. Auto mode never fixes unlabeled issues.
- **No duplicate work.** An issue with a queued or running task, or one that already produced a PR, is skipped with a reason.
- **The PR body says `Fixes #N`,** so merging closes the issue.

## API (built by the planner; FE consumes it)
- `GET /api/issues?repoKey=&label=`
  - → `{ repo: {owner, repo}, issues: IssueRow[], watch: WatchConfig }`
  - `IssueRow = { number, title, url, labels: string[], author: string|null, comments: number, updatedAt: string, task: { id, state, prUrl?, error?, note? } | null }`
  - Errors: 400 `{ error, code: "no_folder" | "no_github_remote" }`, and GitHub errors are passed through with an actionable message.
- `POST /api/issues/fix { repoKey, numbers: number[], deliver?: boolean = true, model? }`
  - → `{ tasks: Task[], skipped: { number, reason }[] }`
- `GET /api/issues/watch?repoKey=` and `PUT /api/issues/watch { repoKey, enabled, label, intervalMinutes }`
  - → `WatchConfig = { enabled, label, intervalMinutes (5–1440), lastCheckedAt?: number, lastError?: string, handled: number }`
- Progress: the fix tasks are ordinary queue tasks (`source: "issue"`, `issueUrl`). `GET /api/tasks` and `/api/tasks/[id]/events` show them live.
- CLI: `viberon issues --repo <path> [--label <l>] [--fix <n,n|all>] [--no-deliver] [--json]`.
