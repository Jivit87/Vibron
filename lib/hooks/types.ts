/**
 * Hook types shared by the config loader, the command protocol, in-process
 * hooks and the engine. See docs/HOOKS.md for the user-facing contract.
 */

export type HookEventName = "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop" | "UserPromptSubmit";

export const HOOK_EVENTS: readonly HookEventName[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
];

/** Events whose matcher is tested against a tool name. Others ignore the matcher. */
export const TOOL_EVENTS: ReadonlySet<HookEventName> = new Set(["PreToolUse", "PostToolUse"]);

/** The wire name used in `hook` stream events (and the UI). */
export const STREAM_EVENT = {
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  SessionStart: "session_start",
  Stop: "stop",
  UserPromptSubmit: "user_prompt_submit",
} as const satisfies Record<HookEventName, string>;

export type HookStreamEvent = (typeof STREAM_EVENT)[HookEventName];

/** Where a hook came from. Only "workspace" hooks need trust. */
export type HookSource = "global" | "workspace" | "builtin";

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const MAX_HOOK_TIMEOUT_MS = 10 * 60_000;

/** A shell hook from a hooks.json file. */
export interface CommandHook {
  kind: "command";
  /** Stable within one file: `<source>:<event>:<entry>.<hook>`. */
  id: string;
  source: "global" | "workspace";
  event: HookEventName;
  matcher?: string;
  command: string;
  timeoutMs: number;
}

/**
 * The payload every hook receives: JSON on stdin for command hooks, the
 * argument for in-process hooks. Field names follow Claude Code's hook
 * input so existing scripts port with little change.
 */
export interface HookInput {
  hook_event_name: HookEventName;
  /** The run id. */
  session_id: string;
  /** Workspace root, or "" for a workspace with no folder on disk. */
  cwd: string;
  agent_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse: the tool's result text (capped). */
  tool_response?: string;
  /** PostToolUse: whether the tool reported a failure. */
  tool_failed?: boolean;
  /** UserPromptSubmit / SessionStart: the user's request. */
  prompt?: string;
  /** SessionStart: which kind of run started. */
  source?: "agent" | "solve";
  /** Stop: the agent's final message (or `finish` summary). */
  last_message?: string;
  /** Stop: true when a Stop hook already blocked this agent once. */
  stop_hook_active?: boolean;
}

/**
 * What a hook decides. Command hooks produce it from their exit code and
 * stdout JSON; in-process hooks return it directly.
 *
 *  - `decision: "deny"` (alias "block") refuses: PreToolUse denies the tool
 *    call, Stop keeps the agent working, UserPromptSubmit rejects the prompt.
 *  - `updatedInput` (PreToolUse) replaces the tool input.
 *  - `additionalContext` is fed to the model: appended to the tool result
 *    (PostToolUse) or to the request (SessionStart, UserPromptSubmit).
 */
export interface HookResult {
  decision?: "allow" | "deny";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

/** A hook registered from TypeScript (built-ins, the SDK). */
export interface InProcessHook {
  kind?: "builtin";
  /** Shown in events and the UI. */
  name: string;
  event: HookEventName;
  matcher?: string;
  timeoutMs?: number;
  run(input: HookInput, context: { signal: AbortSignal }): Promise<HookResult | void | null> | HookResult | void | null;
}

/** "skipped" marks workspace hooks left out because they are not trusted. */
export type HookOutcome = "proceed" | "blocked" | "modified" | "error" | "skipped";

/** One hook execution, for the event stream, the recent-runs list and evidence. */
export interface HookRunRecord {
  id: string;
  at: number;
  repoKey: string;
  runId: string;
  event: HookEventName;
  source: HookSource;
  /** The command, or the in-process hook's name. */
  label: string;
  agentId?: string;
  tool?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outcome: HookOutcome;
  /** Block reason, error message, or feedback preview. */
  message: string;
}
