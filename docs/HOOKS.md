# Hooks

Hooks run your own commands at fixed points of an agent run: before and after every tool call, when a run starts, when a request is submitted, and when an agent tries to finish. You can use them to format or lint a file right after the agent edits it, to refuse a command your team never runs, to rewrite a tool call, or to insist on a check before the agent stops.

The design rule still holds: the model proposes, the harness decides, and tests judge. Hooks add rules to the harness's side of that rule. They never take over from it.

## The problem

Viberon's policies are fixed. The terminal policy (ask/auto/off), the command classifier, write scopes and the verification gate cover the general case, but each project also has rules of its own, such as "run prettier after every edit", "never touch `migrations/`" or "the changelog must be updated". Without hooks, those rules can only go into the prompt, and the model may or may not follow a prompt. A hook is enforced every time.

Hooks also raise a new risk. Viberon's core flow is to clone an arbitrary repository and let agents work in it. If a repository could ship hooks that run on their own, cloning it would be enough to execute its code on your machine.

## Hook points

| Event | When it runs | What a hook can do |
|---|---|---|
| `PreToolUse` | before a tool call runs | allow it; deny it (the reason is sent back to the model as the tool result); or replace its input (`updatedInput`) |
| `PostToolUse` | after a tool call ran | add feedback to the tool result, such as formatter or linter output |
| `SessionStart` | once, when a run starts | add context to the request |
| `UserPromptSubmit` | once, on the user's request | reject the request, or add context to it |
| `Stop` | when an agent tries to finish | block the finish with a reason, which sends the agent back to work |

`PreToolUse` and `PostToolUse` take a **matcher** on the tool name. The other events ignore the matcher.

- If the matcher is missing, empty or `*`, it matches every tool.
- `edit_file` matches exactly that tool.
- `edit_file|write_file` matches any of the listed names. The names are compared exactly, and a `.` in them is literal.
- Anything else is a regular expression, anchored at both ends. For example, `mcp__github__.*` matches every GitHub MCP tool, and `view.*` does not match `preview`. An invalid regex is reported as a config error and never matches anything.

## Configuration

There are two files. Both use the same schema, which is Claude Code's schema plus a shorter flat form.

- **Workspace:** `<repo>/.viberon/hooks.json`. These hooks need your approval before they run (see Security).
- **User:** `~/.viberon/hooks.json`. Set `VIBERON_CONFIG_DIR` to use a different directory. These are your own hooks, so they need no approval and apply to every workspace.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "run_command", "hooks": [{ "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "edit_file|write_file|multi_edit", "command": "f=$(jq -r .tool_input.path); npx prettier --write \"$f\" >/dev/null && npx eslint \"$f\"" }
    ],
    "Stop": [
      { "command": "git diff --quiet CHANGELOG.md && { echo 'Update CHANGELOG.md' >&2; exit 2; } || exit 0" }
    ]
  }
}
```

`timeout` is given in seconds. The default is 60 and the maximum is 600. Hooks run in this order: user file, then workspace file, then in-process hooks, each in the order it appears in its file.

## The command protocol

A command hook runs through the terminal's execution path with the workspace root as its working directory. The event JSON arrives on stdin. The environment variables `VIBERON_HOOK_EVENT`, `VIBERON_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` are set.

```json
{ "hook_event_name": "PreToolUse", "session_id": "<run id>", "cwd": "/repo", "agent_id": "solo",
  "tool_name": "run_command", "tool_input": { "command": "npm test" } }
```

Each event adds its own fields to this payload:

- `PostToolUse` adds `tool_response`, capped at 20k characters, and `tool_failed`.
- `SessionStart` adds `source` (`agent` or `solve`) and `prompt`.
- `UserPromptSubmit` adds `prompt`.
- `Stop` adds `last_message` and `stop_hook_active`.

The hook's exit code tells Viberon what to do:

- **Exit code 0** means proceed. Stdout may contain a JSON decision, which Viberon reads from the whole output or from its last line, so any output from your login profile is tolerated. For `PostToolUse`, `SessionStart` and `UserPromptSubmit`, plain-text stdout is treated as context for the model.
- **Exit code 2** means block. Stderr, or stdout if stderr is empty, is the reason given to the model. For `PostToolUse`, the tool has already run, so the reason is appended to its result instead.
- **Any other exit code**, a timeout, or a failure to start is a **non-blocking error**. It is logged and shown in the UI, and the run continues. A guard that must fail closed should exit 2.

A JSON decision can contain these fields. The Claude Code `hookSpecificOutput` equivalents are also accepted.

```json
{ "decision": "allow" | "deny" | "block", "reason": "...", "updatedInput": { ... }, "additionalContext": "..." }
```

Text that reaches the model from a single hook is capped at 4,000 characters.

## In-process hooks

TypeScript callers, including the future SDK, register hooks with the same interface. They receive the same payload and return the same decision.

```ts
import { registerHook } from "@/lib/hooks";

const unregister = registerHook({
  name: "no-force-push",
  event: "PreToolUse",
  matcher: "run_command",
  run: (input) =>
    /git push .*--force/.test(String(input.tool_input?.command))
      ? { decision: "deny", reason: "Force-pushing is not allowed here." }
      : null,
});
```

An in-process hook gets a structured clone of the payload and an `AbortSignal`, and it is subject to the same timeout as a command hook. If it throws or times out, that is a non-blocking error. To use a hook set for a single run only, pass `new HookEngine({ builtins: [...] })` as `hooks` to `orchestrate`, `solveTask` or `runAgent`.

## Design

- `lib/hooks/types.ts` defines the event names, the payload (`HookInput`), the decision (`HookResult`) and the run records.
- `lib/hooks/matcher.ts` contains the matcher semantics.
- `lib/hooks/protocol.ts` turns an exit code and output into a decision. It is pure and does no I/O.
- `lib/hooks/config.ts` handles the file locations, parsing and the sha256 of each file.
- `lib/hooks/trust.ts` stores the per-workspace, per-hash approvals.
- `lib/hooks/exec.ts` runs command hooks through `lib/terminal` `startCommand`. It passes stdin through, tags the session with `origin: "hook"`, and enforces its own timeout, which kills the whole process group.
- `lib/hooks/engine.ts` holds `HookEngine`, which has one method per hook point and combines the results of all matching hooks. It also contains the in-process registry, the recent-runs log, and `describeHooks`/`loadHookEngine`.

Where the hooks are called from:

- `lib/agents/runner.ts` runs `PreToolUse` before each tool call and before the controller's `beforeMutation`. A modified input is then passed to `runTool`, so every check the tool makes still applies. `PostToolUse` runs after every call that actually executed. `Stop` runs when the model stops, or when `finish` is called.
- `lib/agents/orchestrator.ts` and `lib/harness/solve.ts` load the engine once per run and snapshot it, so editing the hooks file in the middle of a run has no effect. They also run `SessionStart` and `UserPromptSubmit`. The planner's read-only tool calls go through the same `PreToolUse` and `PostToolUse` hooks.
- `lib/headless/run.ts` loads the engine with the trust root set to the repository you named, even when it works in a temporary `--worktree`. It writes every hook run to `result.json` (`hooks`) and to a "Hooks" table in `report.md`. Every hook run is also a `hook` event, so it appears in `trajectory.jsonl`, in the SSE stream, and in the run view. Run-level hooks are shown under the run header, and tool hooks appear in the lane of the agent that made the call.

Rules for combining the results of several hooks:

- **`PreToolUse`:** the first deny wins. `updatedInput` chains, so each hook sees the input as the previous hook left it.
- **`PostToolUse`:** the feedback from every hook is appended, in order.
- **`Stop`:** any deny blocks the finish.
- **`UserPromptSubmit`:** the first deny rejects the request, and context from all hooks is joined.
- **`SessionStart`:** context is joined. It cannot block.

### The Stop hook and the gate

The verification gate always has the final say. A Stop hook can only make finishing harder. It can never accept work.

- When the model stops calling tools, the controller rules first. That is the gate, or the solver's "call finish" nudge. If it rejects the finish, its feedback goes to the model and the Stop hook is not consulted. A Stop hook that says "allow" cannot turn a rejection into an acceptance.
- If the controller has already accepted or given up (`isDone`), the Stop hook is not consulted either, so an accepted task is final.
- When the solver calls `finish`, the Stop hook runs *before* the gate. A deny answers the call as "Finish blocked by a Stop hook (the verification gate did not run)". An allow passes the request to the gate, which still rules on it.
- A Stop hook can block at most 3 times per agent (`MAX_STOP_HOOK_BLOCKS`). After that its objection is ignored, so a hook that always blocks cannot spin the loop until the step limit. The payload's `stop_hook_active` tells the hook that it has already blocked once.

### Key decisions and trade-offs

- **"Allow" is not a bypass.** Unlike Claude Code's `permissionDecision: "allow"`, a hook's allow does not skip Viberon's command approval, classifier or write scope. It only means "no objection". A hook can make the harness stricter but never looser.
- **Errors do not block.** A broken or slow hook logs and moves on, because a typo in a linter hook should not wedge every run. Guards that must fail closed exit 2 explicitly.
- **Hooks run sequentially, not in parallel.** The order is predictable, and `updatedInput` can chain. The cost is that slow hooks add up, so keep hooks fast and use matchers.
- **Trust is stored outside the app store.** The `viberon` CLI runs with an in-memory store, so trust lives in `~/.viberon/hooks-trust.json`. That way an approval made in the desktop app also applies in the CLI, and the reverse.

## Using it

- **Settings → Hooks** lists the workspace and user hooks with any config errors and shows the trust state (trusted, not trusted, or changed since approval). From there you can approve the exact file version shown, identified by its sha256, revoke an approval, and see the 25 most recent hook runs.
- **API:**
  - `GET /api/hooks?repoKey=…` returns the overview and recent runs.
  - `POST /api/hooks {action:"trust", repoKey, hash}` approves the file. It returns a 409 error if the file changed after it was shown.
  - `POST /api/hooks {action:"revoke", repoKey}` withdraws the approval.
- **CLI:**
  - `viberon hooks list [--repo <path>] [--json]`
  - `viberon hooks trust [--repo <path>] [--yes] [--hash <sha256>]` prints every command and asks before approving. `--yes` skips the prompt for CI, and `--hash` pins the exact file version.
  - `viberon hooks revoke [--repo <path>]`

## Security

- **Workspace hooks never run automatically.** A workspace hooks file is code from whoever wrote the repository, so its hooks run only after a one-time approval. The approval is keyed by the workspace's real path and the sha256 of the file. Any change to the file revokes it, whether that change comes from a pull, a branch switch or an agent edit. When hooks are skipped, the run says so on the stream and in the headless log.
- **The approval lives outside the repository.** It is stored in `~/.viberon/hooks-trust.json` with mode 0600. Nothing a repository ships can mark itself trusted, and `"trusted": true` inside a hooks file is ignored.
- **Approval is tied to what you reviewed.** The UI and `--hash` send back the hash that was shown. If the file changed in between, the approval is refused (HTTP 409, or CLI exit code 2).
- **A running agent cannot add hooks.** The hook set is loaded once per run. If an agent writes `.viberon/hooks.json`, the change takes effect in no run until you approve the new hash.
- **The environment is scrubbed.** Hook processes inherit the terminal's scrubbed environment, which removes model API keys, cloud credentials and anything else named like a token, secret or password. They also get a timeout that kills the process group, and they are cancelled with the run.
- **Hooks do not bypass Viberon's policies.** An `updatedInput` goes through the same tool checks as the original input, and an `allow` never skips an approval or the gate.
- **Residual risk: agent commands.** The approved hooks, and the user file `~/.viberon/hooks.json`, run with your permissions, like git hooks. Agent commands under the `auto` policy can also run with your permissions, so they can in principle write outside the workspace, including into `~/.viberon`. Use `ask`, or the Docker sandbox, for untrusted repositories.
