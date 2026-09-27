/**
 * Running a command hook through the terminal's execution path: the same
 * process-group handling, cancellation and scrubbed environment (no API
 * keys, no cloud credentials) as agent commands, with the event JSON on
 * stdin and a hard timeout. Sessions are labelled `origin: "hook"` so the
 * terminal panel can show what ran.
 */

import { killSession, startCommand, subscribe } from "@/lib/terminal";
import type { CommandRun } from "@/lib/hooks/protocol";

/** Per-stream capture cap; the protocol trims further for the model. */
const MAX_CAPTURE = 64_000;
/** After a kill, how long to wait for the process group to close. */
const KILL_GRACE_MS = 6_000;

export interface HookExecOptions {
  command: string;
  stdin: string;
  cwd: string;
  repoKey: string;
  timeoutMs: number;
  runId?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface HookExecResult extends CommandRun {
  durationMs: number;
}

export type HookExecutor = (options: HookExecOptions) => Promise<HookExecResult>;

export const runHookCommand: HookExecutor = async (options) => {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "the run was cancelled", durationMs: 0 };
  }
  const session = startCommand({
    repoKey: options.repoKey,
    command: options.command,
    cwd: options.cwd,
    origin: "hook",
    runId: options.runId,
    signal: options.signal,
    stdin: options.stdin,
    env: options.env,
  });

  let stdout = "";
  let stderr = "";
  let systemText = "";
  for (const chunk of session.chunks) if (chunk.stream === "system") systemText += chunk.text;
  // Output arrives asynchronously, so subscribing right after the spawn misses nothing.
  const unsubscribe = subscribe(session.id, (chunk) => {
    if (chunk.stream === "stdout" && stdout.length < MAX_CAPTURE) stdout += chunk.text;
    else if (chunk.stream === "stderr" && stderr.length < MAX_CAPTURE) stderr += chunk.text;
    else if (chunk.stream === "system") systemText += chunk.text;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    if (session.status === "running") {
      timedOut = true;
      killSession(session.id);
    }
  }, options.timeoutMs);

  try {
    await Promise.race([
      session.done,
      new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, options.timeoutMs + KILL_GRACE_MS);
        cap.unref?.();
        void session.done.then(() => clearTimeout(cap));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }

  const durationMs = Date.now() - startedAt;
  const base = { stdout: stdout.slice(0, MAX_CAPTURE), stderr: stderr.slice(0, MAX_CAPTURE), durationMs };
  if (session.status === "failed") {
    const reason = systemText.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("$ ")).at(-1);
    return { ...base, exitCode: null, timedOut: false, error: reason ?? "the process failed to start" };
  }
  if (options.signal?.aborted && !timedOut) {
    return { ...base, exitCode: session.exitCode, timedOut: false, error: "the run was cancelled" };
  }
  if (timedOut || session.status === "running") {
    return { ...base, exitCode: session.exitCode, timedOut: true };
  }
  return { ...base, exitCode: session.exitCode, timedOut: false };
};
