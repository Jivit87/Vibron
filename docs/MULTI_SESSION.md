# Multi-session support

Several agent sessions can now run at the same time in one workspace, each with its own thread, run and approvals.

## Problem

Before this change a workspace effectively had one agent run at a time:

- The client blocked a second prompt while `streaming` was true.
- The transport kept one module-level `activeController` and `activeRunId`.
- The server had nothing that grouped runs, nothing that limited them, and nothing that stopped two runs from overwriting the same file.

Several shared resources were also unsafe with concurrent writers:

- **The raw-file list and token index.** They are rewritten on every edit with a read-modify-write. In a store workspace the raw-file list *is* the file contents, so a lost update is a lost file.
- **Project memory.** The orchestrator loaded the memory blob at the start of a run and saved it whole at the end. That wiped out anything written in between.
- **Checkpoints.** A checkpoint restore rewrote the whole workspace, so undoing one run reverted everyone's work.

## Design

A **session** is a long-lived lane of work. It has:

- an id and a title;
- a status: `idle`, `queued`, `running`, `awaiting-approval`, `done` or `error`;
- a model, a mode (`shared` or `isolated`), a `createdAt`, and the chat thread it writes to (`conversationId`).

### Server

| Piece | Where | What it does |
|---|---|---|
| Session manager | `lib/sessions/manager.ts`, singleton in `lib/sessions/index.ts` | Handles the session lifecycle: create, list, rename, cancel, delete, and sweep. It schedules runs against the concurrency limit. It tracks per-session bookkeeping from the run's own events: status, pending approvals, token ledger, and a replay buffer. |
| Cross-session file lock | `lib/sessions/file-locks.ts`, `claimWrite` in `lib/tools/registry.ts` | The first session to write a file holds it until its run ends. A write from any other session gets a tool error that names the holder. |
| Session checkpoints | `lib/checkpoints` (`createSessionCheckpoint`, `journalFileChange`) | A journal of one session's writes, holding each file's pre-image and its latest content. Restoring it reverts only those files. |
| Per-session undo | `lib/sessions/undo.ts` | Restores the session's checkpoints, newest first. |
| Isolated mode | `lib/headless/worktree.ts` (shared with `viberon run --worktree`), `lib/sessions/isolated.ts` | Runs the session in a detached git worktree of HEAD. **Apply** brings its change back with `git apply`. |
| Keyed mutex | `lib/concurrency/keyed-mutex.ts` | The Promise-chain lock from `graph-index.ts`, made reusable. |

### The agent route

`POST /api/agent` takes an optional `sessionId`. With one, the run is session-scoped:

1. The route checks that the session exists and belongs to `repoKey`. If not, it returns 404. If the session already has a run, it returns 409.
2. The run is registered with its session (`createRun(..., {sessionId, label})`). That is how the tool layer attributes file locks.
3. A session-scoped checkpoint is created. Every `file_change` event is journaled into it.
4. The run waits for a slot (`acquireSlot`). While it waits, the stream carries `{type:"session", status:"queued", position}` events, followed by `status:"running"` once it starts.
5. Every event also feeds the session's status, ledger and replay buffer. When the run ends, the session settles its ledger, frees the slot and releases the locks.

An isolated session opens its worktree's workspace handle, and its hooks are trust-checked against the main checkout. Runs without a `sessionId` behave as before, and they still take file locks under their run id.

### Client

- **Store (`store/viberon.ts`).** The active session's state stays in the existing top-level fields: `messages`, `run`, `streaming`, `conversationId` and so on. Every panel therefore renders unchanged.
  - Each background session keeps a `slice` of those fields on its `ClientSession`.
  - Every run mutation takes an optional `sessionId`: `applyEvent`, `appendMessage`, `appendToLastAssistant`, `startRun`, `endRun` and `resolveApproval`. An event for a background session updates that session's slice, so switching never drops events.
  - `switchSession` parks the current slice on its session and loads the target's.
- **Transport (`lib/client/agent-stream.ts`).** Open streams are keyed by session, so several can pump at once.
  - Side effects such as opening a preview tab happen only for the session on screen.
  - A background session that needs an approval, finishes or fails raises a notification through `notifySession` (`lib/client/notify.ts`). In Electron that is the preload's native `notify` bridge when it exists; otherwise it is an in-app toast with an **Open** action. The web Notification API is not used.
- **Sessions client (`lib/client/sessions.ts`).** Handles hydration, create, switch, rename, stop, close, undo, apply and the limit setting.
  - Hydration binds the server's sessions to the threads in conversation storage, and creates the first session for the thread on screen.
  - It reattaches to runs that were live before a reload, through the replay endpoint.
- **UI (`components/vibe/SessionSwitcher.tsx`).**
  - The Chat header has a tab strip. The IDE agent dock has a compact dropdown.
  - Each session shows a status dot, and a marker when it needs your attention.
  - Available actions: new (shared or isolated), rename (double-click, or **Rename**), stop, undo, apply, and close.
  - A "Queued #n" line sits above the composer while the run waits.
  - **Settings → Agents → Concurrent sessions** sets the limit.

## Key decisions and trade-offs

- **Lease-style locks, held until the run ends.** Per-write mutexes would only serialize writes; two sessions could still interleave edits to one file and corrupt each other's work. Holding the file for the rest of the run gives the model a clear, actionable error that names the other session.
  - The trade-off is coarser granularity: a session that touched a file once holds it until its run finishes.
  - Parallel agents *inside* one session share the session's locks. The orchestrator's per-step `writeScope` already keeps those apart.
- **The lock scope is the workspace root.** An isolated session writes to another root, so it never contends. Its **Apply** step checks the main checkout's locks instead.
- **The session checkpoint is a journal, not a snapshot.** It costs nothing up front and touches only the session's own files.
  - A file changed by someone else after the session last wrote it is reported as a conflict and left alone. `force: true` overrides this.
  - A file another session currently holds locked is never touched, even with `force`.
  - After a restore, the journal's "latest" becomes the pre-image, so undoing twice is a no-op.
- **Whole-workspace checkpoints are refused (409) while any session's run is active.** Restoring one would revert every running session's files.
- **Fix mode is exclusive in a shared checkout.** `solveTask` snapshots, diffs and rolls back the *whole tree* with git. A fix run in a shared session therefore waits until no other shared run is active, and blocks new ones while it runs. Isolated sessions are unaffected.
- **The queue is strict FIFO with a per-workspace limit.** The default is 3, configurable from 1 to 12, or with `VIBERON_MAX_SESSIONS`.
  - Strict ordering keeps an exclusive run from being starved.
  - Raising the limit starts queued runs at once.
- **Memory writes are merged, not saved over.** `commitMemory(base, local)` applies only one run's own delta under a per-workspace memory lock. The delta covers entries and tasks by id, a rewritten overview, and stats increments. `refreshMemory` between waves merges first, which also stops the orchestrator losing entries its agents recorded in earlier waves.
- **Graph and raw-file writes are serialized per workspace.** This covers `patchWorkspaceFile` and store-backed deletes. The graph index already had its own lock; memory-graph writes are synchronous and so already atomic.
- **Sessions are in memory on the server, like the run registry.** Their threads persist client-side, as before.
  - After a server restart, hydration re-creates a session for the thread on screen.
  - While the server is up, a reloaded page reattaches through `GET /api/sessions/:id/events`.
- **Cleanup.** A sweep runs on every list, and every 5 minutes on an unref'd timer.
  - A session whose run vanished from the run registry is marked `error` and unlocked.
  - Inactive sessions untouched for `idleTtlMs` are deleted, together with their worktrees. The default is 24 h, or set `VIBERON_SESSION_TTL_MS`.

## How to use it

In the app:

1. Click **+** in the Chat header (or pick **New session** in the IDE dock's session menu) to open a session. Choose **New isolated session** to work in a git worktree.
2. Type a prompt in each session. Runs beyond the limit show **Queued #n** and start automatically.
3. Switch sessions freely; the other sessions keep streaming. A dot on a tab marks a session that needs approval or has finished.
4. Use the tab's **⋯** menu to **Undo this session's changes**, which leaves other sessions' files alone. For an isolated session, **Apply to workspace** brings its changes into the checkout.

API:

```
GET    /api/sessions?repoKey=…            → { sessions, config, running, queued }
POST   /api/sessions                      { repoKey, title?, model?, conversationId?, mode?: "shared"|"isolated" }
PUT    /api/sessions                      { maxConcurrent?, idleTtlMs? } → { config }
GET    /api/sessions/:id                  → { session }
PATCH  /api/sessions/:id                  { title?, model?, conversationId? }
DELETE /api/sessions/:id
POST   /api/sessions/:id/cancel           → { ok }
POST   /api/sessions/:id/undo             { checkpointId?, force? } → { restored, deleted, conflicts, checkpoints }
GET    /api/sessions/:id/events           → SSE replay of the current/last run, then the live tail
GET    /api/sessions/:id/apply            → { files, patch }          (isolated only)
POST   /api/sessions/:id/apply            → { ok, files }             (isolated only)
POST   /api/agent                         { …, sessionId }            (session-scoped run)
```

Environment defaults: `VIBERON_MAX_SESSIONS` (default 3) and `VIBERON_SESSION_TTL_MS` (default 24 h). A value saved from Settings overrides the environment default.

There is no CLI flag. `viberon run` is a single headless run, and `--worktree` already gives it the same isolation an isolated session uses.

## Security considerations

- **No new trust boundary.** Session routes are local API routes, like `/api/agent`, and every id is re-validated. A session must belong to the `repoKey` a run names, and unknown ids return 404.
- **Worktree paths are never client-supplied.** They are created under the OS temp dir by the server. Apply uses a fixed-argv `git apply` (via `runGit`, with a scrubbed environment and no fsmonitor) on a patch file in a private temp dir.
- **Isolated sessions do not widen hook trust.** Hooks in a worktree are trusted only as the main checkout's hooks are (`trustRoot`), the same rule `viberon run --worktree` follows.
- **The lock can be bypassed by `run_command`.** A shell command can still write any file. The lock covers the agent's file tools, which are how agents edit; commands keep their existing approval policy. Undo reports a file changed out from under a session as a conflict rather than silently overwriting it.
- **The lock-conflict message exposes only the other session's title and id,** which are both already visible in the UI.

## Limitations

- Locks and sessions are per server process; two app processes on one checkout do not see each other's locks.
- Undo covers the agent's file-tool writes. Changes made by shell commands (for example `npm install` or a code generator) are not journaled.
- **Apply** fails with 409 when the main checkout has moved on in a conflicting way. Resolve it by hand, or re-run the task in a fresh isolated session.
- A closed tab still stops that tab's runs, as before (nobody is left to answer approvals). Background sessions keep running as long as the page that started them is open.
