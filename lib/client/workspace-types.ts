/**
 * Client-side mirrors of the workspace API shapes (docs/PLAN.md §3.3).
 *
 * The server modules (`lib/git`, `lib/problems`) are owned by another
 * implementer; the browser compiles against these copies so the UI does not
 * import server code. Keep them in step with the contract, not the impl.
 */

export type GitChangeGroup = "staged" | "changes" | "untracked" | "conflicts";

export interface GitFileChange {
  path: string;
  originalPath?: string;
  group: GitChangeGroup;
  /** Porcelain letter: M, A, D, R, C, U, ? … */
  letter: string;
}

export interface GitBranchInfo {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  branch: GitBranchInfo;
  files: GitFileChange[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** Epoch ms or an ISO string, depending on the producer. */
  date: number | string;
  subject: string;
}

export interface GitSnapshot {
  virtual: boolean;
  isRepo: boolean;
  gitAvailable: boolean;
  parentRepo: string | null;
  status?: GitStatus;
  branches?: GitBranch[];
  log?: GitCommit[];
}

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  file: string;
  line: number;
  col: number;
  severity: ProblemSeverity;
  message: string;
  source: string;
  code?: string;
}

export interface CheckerRun {
  checker: string;
  ran?: boolean;
  note?: string;
  durationMs?: number;
  count?: number;
}

export interface ProblemsResult {
  virtual: boolean;
  problems: Problem[];
  checkers: CheckerRun[];
  finishedAt: number | null;
  running: boolean;
}

export interface ProblemGroup {
  file: string;
  problems: Problem[];
  errors: number;
  warnings: number;
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Group by file, dedupe identical entries (editor markers and tsc often
 * report the same error), and sort: files with errors first, then by path;
 * within a file by position.
 */
export function groupProblems(problems: readonly Problem[]): ProblemGroup[] {
  const byFile = new Map<string, Map<string, Problem>>();
  for (const problem of problems) {
    const key = `${problem.line}:${problem.col}:${problem.severity}:${problem.message}`;
    const bucket = byFile.get(problem.file) ?? new Map<string, Problem>();
    if (!bucket.has(key)) bucket.set(key, problem);
    byFile.set(problem.file, bucket);
  }
  const groups: ProblemGroup[] = [];
  for (const [file, bucket] of byFile) {
    const list = [...bucket.values()].sort(
      (a, b) =>
        a.line - b.line || a.col - b.col || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    groups.push({
      file,
      problems: list,
      errors: list.filter((p) => p.severity === "error").length,
      warnings: list.filter((p) => p.severity === "warning").length,
    });
  }
  return groups.sort(
    (a, b) => Number(b.errors > 0) - Number(a.errors > 0) || a.file.localeCompare(b.file),
  );
}

/** Plain-text rendering of problems, for "add to chat". */
export function problemsToText(problems: readonly Problem[], max = 60): string {
  const lines = problems
    .slice(0, max)
    .map(
      (p) =>
        `${p.file}:${p.line}:${p.col} ${p.severity}${p.code ? ` ${p.code}` : ""}: ${p.message}`,
    );
  if (problems.length > max) lines.push(`… ${problems.length - max} more`);
  return lines.join("\n");
}

/** Files grouped for the Source Control view, in VS Code's section order. */
export function groupScmFiles(
  files: readonly GitFileChange[],
): { group: GitChangeGroup; label: string; files: GitFileChange[] }[] {
  const order: { group: GitChangeGroup; label: string }[] = [
    { group: "conflicts", label: "Merge Changes" },
    { group: "staged", label: "Staged Changes" },
    { group: "changes", label: "Changes" },
    { group: "untracked", label: "Untracked" },
  ];
  return order
    .map(({ group, label }) => ({
      group,
      label,
      files: files.filter((f) => f.group === group).sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .filter((section) => section.files.length > 0);
}
