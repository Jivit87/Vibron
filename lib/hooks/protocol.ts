/**
 * The command-hook protocol: exit code + stdout/stderr → a decision.
 *
 *   exit 0   proceed. stdout may hold a JSON decision object; plain text is
 *            model-facing context for PostToolUse, SessionStart and
 *            UserPromptSubmit, and ignored for the others.
 *   exit 2   block. stderr (or stdout when stderr is empty) is the reason
 *            fed back to the model. For PostToolUse the tool already ran,
 *            so the reason is appended to its result instead.
 *   other    a non-blocking error: logged and shown, the run proceeds.
 *
 * Timeouts and spawn failures are non-blocking errors too: a broken hook
 * must not wedge the agent. Guards that need to fail closed exit 2.
 *
 * Pure: no I/O, so it is tested directly.
 */

import type { HookEventName, HookResult } from "@/lib/hooks/types";

/** Model-facing text from one hook is capped; a noisy linter cannot flood the context. */
export const MAX_HOOK_TEXT = 4_000;

export interface CommandRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure or similar; the command never produced an exit code. */
  error?: string;
}

export type ParsedHookRun =
  | { status: "ok"; result: HookResult }
  | { status: "error"; message: string };

const CONTEXT_EVENTS: ReadonlySet<HookEventName> = new Set(["PostToolUse", "SessionStart", "UserPromptSubmit"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function capText(text: string, max = MAX_HOOK_TEXT): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n… [${trimmed.length - max} chars trimmed]` : trimmed;
}

/**
 * Normalize a decision object from a command's stdout or an in-process
 * hook. Accepts Viberon's flat shape and Claude Code's
 * `hookSpecificOutput` shape; unknown or mistyped fields are dropped.
 */
export function normalizeHookResult(raw: unknown): HookResult {
  if (!isRecord(raw)) return {};
  const specific = isRecord(raw.hookSpecificOutput) ? raw.hookSpecificOutput : {};
  const out: HookResult = {};

  const decisionRaw = [raw.decision, specific.permissionDecision].find((d) => typeof d === "string") as
    | string
    | undefined;
  const decision = decisionRaw?.toLowerCase();
  if (decision === "allow" || decision === "approve") out.decision = "allow";
  else if (decision === "deny" || decision === "block") out.decision = "deny";
  // `continue: false` is Claude Code's "stop everything"; here it blocks.
  if (raw.continue === false) out.decision = "deny";

  const reason = [raw.reason, specific.permissionDecisionReason, raw.stopReason].find(
    (r) => typeof r === "string" && r.trim(),
  ) as string | undefined;
  if (reason) out.reason = capText(reason);

  const updated = isRecord(raw.updatedInput) ? raw.updatedInput : isRecord(specific.updatedInput) ? specific.updatedInput : null;
  if (updated) out.updatedInput = { ...updated };

  const context = [raw.additionalContext, specific.additionalContext, raw.feedback].find(
    (c) => typeof c === "string" && c.trim(),
  ) as string | undefined;
  if (context) out.additionalContext = capText(context);
  return out;
}

/**
 * The JSON object in stdout, if any. A login shell's profile can print
 * before the hook does, so after the whole text the last line is tried.
 */
export function extractJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  const candidates = [text];
  const lastLine = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (lastLine && lastLine !== text) candidates.push(lastLine);
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return null;
}

export function parseCommandRun(event: HookEventName, run: CommandRun): ParsedHookRun {
  if (run.error) return { status: "error", message: `hook failed to run: ${run.error}` };
  if (run.timedOut) return { status: "error", message: "hook timed out and was killed" };

  if (run.exitCode === 2) {
    const reason = capText(run.stderr) || capText(run.stdout) || "Blocked by a hook (exit code 2).";
    return event === "PostToolUse"
      ? { status: "ok", result: { decision: "deny", reason, additionalContext: reason } }
      : { status: "ok", result: { decision: "deny", reason } };
  }

  if (run.exitCode === 0) {
    const json = extractJson(run.stdout);
    if (json) return { status: "ok", result: normalizeHookResult(json) };
    const text = capText(run.stdout);
    return { status: "ok", result: text && CONTEXT_EVENTS.has(event) ? { additionalContext: text } : {} };
  }

  const detail = capText(run.stderr, 500) || capText(run.stdout, 500);
  return {
    status: "error",
    message: `hook exited ${run.exitCode ?? "without a code"}${detail ? `: ${detail}` : ""}`,
  };
}
