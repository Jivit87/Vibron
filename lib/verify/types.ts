/**
 * Verification contracts: how the harness finds and runs a repository's own
 * checks, independently of the model. Implemented in lib/verify/*.
 */

export type TestFramework =
  | "pytest"
  | "unittest"
  | "jest"
  | "vitest"
  | "node-test"
  | "go"
  | "cargo"
  | "maven"
  | "gradle"
  | "make"
  | "npm-script"
  | "custom";

export interface VerifyCommand {
  command: string;
  framework: TestFramework;
  kind: "test" | "typecheck" | "compile" | "lint";
  /** Command with `{files}` placeholder for targeted runs, e.g. "python -m pytest -q -rA {files}". */
  targetTemplate?: string;
  /** Why this command was chosen, for the report. */
  source: string;
}

export type TestOutcome = "pass" | "fail" | "error" | "skip";

export interface VerificationReport {
  command: string;
  kind: VerifyCommand["kind"];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Whether per-test outcomes could be parsed from the output. */
  parsed: boolean;
  tests: Record<string, TestOutcome>;
  counts: { passed: number; failed: number; errors: number; skipped: number };
  failureExcerpt: string;
  outputTail: string;
}

export interface RunVerificationOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Restrict to these test files (uses `targetTemplate`). */
  targets?: string[];
  runId?: string;
}
