/**
 * Run one verification command in the repo's environment and turn its
 * output into a `VerificationReport`. Non-login `bash -c` with the repo env
 * (venv first on PATH), stdin closed, own process group killed on timeout
 * or abort — the same discipline as Pramana's `tools/shell.py`.
 */

import { spawn } from "node:child_process";

import { buildRepoEnv } from "@/lib/verify/env";
import { extractFailures } from "@/lib/verify/extract";
import { cleanOutput, parseTestOutput } from "@/lib/verify/parse";
import type {
  RunVerificationOptions,
  TestOutcome,
  VerificationReport,
  VerifyCommand,
} from "@/lib/verify/types";

const MAX_CAPTURE = 4 * 1024 * 1024;

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a shell command in `root` with the repo environment. Never throws. */
/** A command runner with the shape of `execInRepo`, injectable for tests. */
export type ShellRunner = (
  cwd: string,
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> },
) => Promise<ExecResult>;

export function execInRepo(
  root: string,
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let head = "";
    let tail = "";
    let total = 0;
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      total += text.length;
      if (head.length < MAX_CAPTURE / 2) head += text;
      else tail = (tail + text).slice(-MAX_CAPTURE / 2);
    };
    let timedOut = false;
    let settled = false;
    const isWindows = process.platform === "win32";
    let child;
    try {
      child = spawn(isWindows ? "cmd.exe" : "bash", isWindows ? ["/c", command] : ["-c", command], {
        cwd: root,
        env: { ...buildRepoEnv(root), ...options.env } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWindows,
      });
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, output: `failed to start: ${String(error)}`, durationMs: 0 });
      return;
    }
    const kill = () => {
      if (!child.pid) return;
      try {
        if (isWindows) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const middle = total > head.length + tail.length ? "\n[… output too large, middle discarded …]\n" : "";
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        output: head + middle + tail + extra,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (error) => finish(null, `\nprocess error: ${error.message}\n`));
    child.on("close", (code) => finish(code));
  });
}

/** Expand `{files}` in a target template with shell-quoted paths. */
export function targetCommand(cmd: VerifyCommand, targets: string[] | undefined): string {
  if (!targets?.length || !cmd.targetTemplate) return cmd.command;
  return cmd.targetTemplate.replace("{files}", targets.map(shellQuote).join(" "));
}

export async function runVerification(
  root: string,
  cmd: VerifyCommand,
  options: RunVerificationOptions,
): Promise<VerificationReport> {
  const command = targetCommand(cmd, options.targets);
  const result = await execInRepo(root, command, { timeoutMs: options.timeoutMs, signal: options.signal });
  const output = cleanOutput(result.output);
  const parsed = cmd.kind === "test" ? parseTestOutput(cmd.framework, output) : { tests: {}, summary: null };
  const tests: Record<string, TestOutcome> = parsed.tests;
  const counted = { passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const outcome of Object.values(tests)) {
    if (outcome === "pass") counted.passed += 1;
    else if (outcome === "fail") counted.failed += 1;
    else if (outcome === "error") counted.errors += 1;
    else counted.skipped += 1;
  }
  const counts = { ...counted, ...(parsed.summary ?? {}) };
  const failedRun = result.timedOut || (result.exitCode ?? 1) !== 0;
  if (failedRun && counts.failed + counts.errors === 0) {
    // Non-zero exit with nothing attributable (crash, import error, timeout).
    counts.errors = 1;
  }
  return {
    command,
    kind: cmd.kind,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    parsed: Object.keys(tests).length > 0 || parsed.summary !== null,
    tests,
    counts,
    failureExcerpt: failedRun
      ? (result.timedOut ? `[timed out after ${Math.round(options.timeoutMs / 1000)}s]\n` : "") +
        extractFailures(output, 4000)
      : "",
    outputTail: output.slice(-2000),
  };
}
