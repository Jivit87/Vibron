/**
 * The side-by-side view of an experiment's branches. Pure (no Node APIs),
 * so the browser panel and the CLI table render from the same rows.
 */

import type { ExperimentBranch, ExperimentRecord } from "@/lib/experiments/types";

export interface ComparisonRow {
  rank: number | null;
  branchId: string;
  label: string;
  mode: "solve" | "plan";
  model: string;
  status: ExperimentBranch["status"];
  /** The solve status when the branch finished, else its run state. */
  verdict: string;
  fixed: number;
  regressed: number;
  files: number;
  adds: number;
  removes: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
  score: number | null;
  planVersionId?: string;
  worktree: string | null;
  promoted: boolean;
  /** Finished with a change: its patch can be applied. */
  canPromote: boolean;
}

export interface ExperimentComparison {
  id: string;
  task: string;
  status: ExperimentRecord["status"];
  winner: string | null;
  rows: ComparisonRow[];
}

/** Branches side by side, best first (unscored branches last). */
export function compareExperiment(record: ExperimentRecord): ExperimentComparison {
  const promoted = record.promotion && !record.promotion.undoneAt ? record.promotion.branchId : null;
  const rows: ComparisonRow[] = record.branches.map((b) => ({
    rank: b.score?.rank ?? null,
    branchId: b.id,
    label: b.label,
    mode: b.variant.mode,
    model: b.variant.model,
    status: b.status,
    verdict: b.evidence?.status ?? b.status,
    fixed: b.evidence?.fixed.length ?? 0,
    regressed: b.evidence?.regressed.length ?? 0,
    files: b.evidence?.diff.files ?? 0,
    adds: b.evidence?.diff.adds ?? 0,
    removes: b.evidence?.diff.removes ?? 0,
    tokens: b.evidence?.tokens ?? 0,
    costUsd: b.evidence?.costUsd ?? 0,
    durationMs: b.evidence?.durationMs ?? 0,
    score: b.score?.value ?? null,
    ...(b.variant.planVersionId ? { planVersionId: b.variant.planVersionId } : {}),
    worktree: b.worktree,
    promoted: promoted === b.id,
    canPromote: b.status === "done" && (b.evidence?.filesChanged.length ?? 0) > 0,
  }));
  rows.sort((x, y) => (x.rank ?? Infinity) - (y.rank ?? Infinity) || x.branchId.localeCompare(y.branchId));
  return { id: record.id, task: record.task, status: record.status, winner: record.winner, rows };
}

/** A fixed-width table for the CLI. */
export function renderComparison(cmp: ExperimentComparison): string {
  const header = ["#", "branch", "variant", "verdict", "fixed", "regr", "diff", "tokens", "cost", "time"];
  const rows = cmp.rows.map((r) => [
    r.rank === null ? "-" : String(r.rank),
    `${r.branchId}${r.branchId === cmp.winner ? "*" : ""}`,
    r.label.slice(0, 32),
    r.verdict,
    String(r.fixed),
    String(r.regressed),
    `+${r.adds}/-${r.removes}`,
    r.tokens.toLocaleString("en-US"),
    `$${r.costUsd.toFixed(3)}`,
    `${Math.round(r.durationMs / 1000)}s`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  const out = [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
  out.push(cmp.winner ? `* winner: ${cmp.winner}` : "No branch produced a change without regressions.");
  return `${out.join("\n")}\n`;
}
