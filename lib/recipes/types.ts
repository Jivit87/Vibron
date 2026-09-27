/**
 * Recipe shapes shared by the server (loader, runner, routes, CLI) and the
 * browser (the recipe dialog). Dependency-free so the client can import it.
 */

export type ParamType = "string" | "number" | "boolean" | "enum" | "path";
export type ParamValue = string | number | boolean;

export interface RecipeParam {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
  default?: ParamValue;
  /** Allowed values for `enum`. */
  values?: string[];
}

export type StepKind = "agent" | "shell" | "verify";

interface StepBase {
  id: string;
  title: string;
  /** Source text of the condition; absent = run while the recipe has not failed. */
  when?: string;
  /** A failure is recorded but does not fail the recipe or stop later steps. */
  continueOnError: boolean;
  /** Wall-clock cap for shell and verify steps, seconds. */
  timeoutSec?: number;
}

export interface AgentStep extends StepBase {
  kind: "agent";
  prompt: string;
  /** A role from the specialist roster (lib/agents/roles). */
  role: string;
  /** Subset of the role's tools; absent = the role's own list. */
  tools?: string[];
  /** Files the step owns: its exclusive write scope. Empty = unrestricted. */
  files: string[];
  maxTurns?: number;
}

export interface ShellStep extends StepBase {
  kind: "shell";
  command: string;
}

export interface VerifyStep extends StepBase {
  kind: "verify";
  /** Custom check command; absent = the repository's auto-detected check. */
  command?: string;
  /** Restrict auto-detection to one kind of check. */
  checkKind?: "test" | "typecheck" | "compile" | "lint";
  /** Test files to target (uses the detected command's file template). */
  targets: string[];
}

export type RecipeStep = AgentStep | ShellStep | VerifyStep;

export interface Recipe {
  name: string;
  description: string;
  version: string;
  author?: string;
  params: RecipeParam[];
  steps: RecipeStep[];
}

export type RecipeSource = "repo" | "global" | "builtin" | "file";

/** One validation problem, with the source line when known. */
export interface RecipeIssue {
  /** Path of the offending node, e.g. `steps[1].agent.role`. */
  path: string;
  message: string;
  line?: number;
}

/** A recipe as listed: where it came from, and whether it is valid. */
export interface RecipeEntry {
  name: string;
  source: RecipeSource;
  /** Absolute file path; absent for built-ins. */
  path?: string;
  recipe?: Recipe;
  errors?: RecipeIssue[];
  /** A lower-precedence recipe with the same name that this one hides. */
  shadows?: RecipeSource[];
}

export type StepStatus = "succeeded" | "failed" | "skipped";

export interface StepOutcome {
  id: string;
  kind: StepKind;
  title: string;
  status: StepStatus;
  /** Agent summary, or condensed command / check output. */
  output: string;
  error?: string;
  durationMs: number;
}

export function formatIssue(issue: RecipeIssue): string {
  return `${issue.line ? `line ${issue.line}: ` : ""}${issue.path ? `${issue.path}: ` : ""}${issue.message}`;
}
