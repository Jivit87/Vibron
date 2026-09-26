/**
 * The harness's view of the terminal.
 *
 * Every command an agent starts is attributed to its run (so cancel can kill
 * it) and labelled `origin: "agent"` unless the caller says otherwise (so the terminal panel can tell it apart
 * from what the user typed).
 */

import * as terminal from "@/lib/terminal";
import type { RunOptions, TerminalSession } from "@/lib/terminal";

type AgentRunOptions = RunOptions;

/** Start a command attributed to a run; returns immediately. */
export function startRunCommand(options: AgentRunOptions): TerminalSession {
  return terminal.startCommand({ origin: "agent", ...options });
}

/** Run a command to completion (or timeout, or cancellation). */
export function runRunCommand(options: AgentRunOptions & { maxOutputChars?: number }) {
  return terminal.runCommand({ origin: "agent", ...options });
}

export function killSessionsByRun(runId: string): number {
  return terminal.killSessionsByRun(runId);
}
