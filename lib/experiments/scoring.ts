/**
 * Scoring experiment branches with the harness's own evidence.
 *
 * Ranking is lexicographic, most important first:
 *   1. verdict tier   resolved > unverified > incomplete > failed > error
 *   2. regressions    fewer tests broken
 *   3. fixed          more tests turned from failing to passing
 *   4. diff size      smaller change (the same result with less code wins)
 *   5. cost, 6. tokens, 7. time
 *
 * A clear order beats a weighted sum: no amount of saved tokens should
 * outrank a regression, and a proven fix beats an unproven one outright.
 * `value` folds the same order into one number for display.
 */

import type { SolveResult, SolveStatus } from "@/lib/harness/solve-types";
import type { BranchEvidence, ExperimentBranch } from "@/lib/experiments/types";

export const VERDICT_TIER: Record<SolveStatus, number> = {
  resolved: 4,
  unverified: 3,
  incomplete: 2,
  failed: 1,
  error: 0,
};

/** Files and +/- lines of a unified diff (binary and header lines excluded). */
export function diffStats(patch: string): BranchEvidence["diff"] {
  let files = 0;
  let adds = 0;
  let removes = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) removes += 1;
  }
  return { files, adds, removes };
}

export function evidenceFrom(result: SolveResult): BranchEvidence {
  const m = result.metrics;
  return {
    status: result.status,
    summary: result.summary,
    gateReason: result.gate.reason,
    fixed: [...result.gate.fixed],
    regressed: [...result.gate.newFailures],
    filesChanged: [...result.filesChanged],
    diff: diffStats(result.diff),
    tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens,
    inputTokens: m.inputTokens + m.cacheReadTokens,
    outputTokens: m.outputTokens,
    costUsd: m.costUsd,
    durationMs: m.durationMs,
    modelCalls: m.modelCalls,
    ...(result.error ? { error: result.error } : {}),
  };
}

type Key = [number, number, number, number, number, number, number];

function key(e: BranchEvidence): Key {
  // Negated where smaller is better, so every component sorts descending.
  return [
    VERDICT_TIER[e.status] ?? 0,
    -e.regressed.length,
    e.fixed.length,
    -(e.diff.adds + e.diff.removes),
    -e.costUsd,
    -e.tokens,
    -e.durationMs,
  ];
}

/** Negative when `a` ranks above `b`. */
export function compareEvidence(a: BranchEvidence, b: BranchEvidence): number {
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return 0;
}

function value(e: BranchEvidence): number {
  const lines = e.diff.adds + e.diff.removes;
  return Math.round(
    VERDICT_TIER[e.status] * 1000 - e.regressed.length * 100 + Math.min(e.fixed.length, 20) * 10 - Math.min(lines, 500) / 100,
  );
}

/**
 * Score and rank the finished branches in place; returns the winner's id:
 * the top branch, provided it produced a change and broke nothing.
 */
export function rankBranches(branches: ExperimentBranch[]): string | null {
  const scored = branches.filter((b) => b.evidence);
  const order = [...scored].sort((a, b) => compareEvidence(a.evidence!, b.evidence!) || a.id.localeCompare(b.id));
  order.forEach((branch, index) => {
    const e = branch.evidence!;
    branch.score = {
      value: value(e),
      rank: index + 1,
      verdictTier: VERDICT_TIER[e.status] ?? 0,
      regressions: e.regressed.length,
      fixed: e.fixed.length,
      diffLines: e.diff.adds + e.diff.removes,
      costUsd: e.costUsd,
      tokens: e.tokens,
      durationMs: e.durationMs,
    };
  });
  const top = order[0]?.evidence;
  if (!top || !top.filesChanged.length || top.regressed.length || VERDICT_TIER[top.status] < VERDICT_TIER.incomplete) return null;
  return order[0]!.id;
}
