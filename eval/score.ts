/**
 * Eval scoring: aggregate per-task rows into the metrics table the brief
 * asks for (pass rate, regressions, tokens, calls, time) and render it.
 */

export interface EvalRow {
  task: string;
  title: string;
  language: string;
  category?: string;
  /** Harness verdict (SolveStatus). */
  status: string;
  /** Hidden tests pass: the only thing that counts as solved. */
  resolved: boolean;
  exitCode: number;
  /** Tests that passed in the gate baseline and failed at the end. */
  regressions: number;
  tokens: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
  seconds: number;
  gradeTail: string;
  outDir: string;
  error?: string;
}

export interface EvalSummary {
  total: number;
  resolved: number;
  passRate: number;
  /** Harness said resolved/unverified AND hidden tests agree. */
  honestVerdicts: number;
  regressions: number;
  tokens: number;
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
  seconds: number;
}

export interface EvalReport {
  generatedAt: string;
  model: string;
  summary: EvalSummary;
  rows: EvalRow[];
}

export function summarize(rows: EvalRow[]): EvalSummary {
  const sum = (pick: (row: EvalRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
  const resolved = rows.filter((r) => r.resolved).length;
  return {
    total: rows.length,
    resolved,
    passRate: rows.length ? resolved / rows.length : 0,
    honestVerdicts: rows.filter((r) => (r.status === "resolved") === r.resolved).length,
    regressions: sum((r) => r.regressions),
    tokens: sum((r) => r.tokens),
    modelCalls: sum((r) => r.modelCalls),
    toolCalls: sum((r) => r.toolCalls),
    costUsd: sum((r) => r.costUsd),
    seconds: sum((r) => r.seconds),
  };
}

export function renderMarkdown(report: EvalReport): string {
  const s = report.summary;
  const lines = [
    `# Viberon eval results`,
    "",
    `Generated ${report.generatedAt} with \`${report.model}\`.`,
    "",
    `**Resolved ${s.resolved}/${s.total} (${(s.passRate * 100).toFixed(0)}%)** by hidden tests · ` +
      `honest verdicts ${s.honestVerdicts}/${s.total} · regressions ${s.regressions} · ` +
      `${s.tokens.toLocaleString()} tokens · ${s.modelCalls} model calls · ${s.toolCalls} tool calls · ` +
      `${s.seconds.toFixed(0)}s${s.costUsd ? ` · $${s.costUsd.toFixed(4)}` : ""}`,
    "",
    "| task | category | harness verdict | hidden tests | regressions | tokens | model calls | tool calls | time |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (r) =>
        `| ${r.task} | ${r.category ?? r.language} | ${r.status} | ${r.resolved ? "PASS" : "FAIL"} | ${r.regressions} | ` +
        `${r.tokens.toLocaleString()} | ${r.modelCalls} | ${r.toolCalls} | ${r.seconds.toFixed(0)}s |`,
    ),
    "",
    "A task counts as resolved only if its hidden tests (never shown to the agent) pass.",
    "\"Honest verdict\" means the harness's own claim (resolved or not) matched the hidden tests.",
  ];
  const failures = report.rows.filter((r) => !r.resolved);
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const r of failures) {
      lines.push(`### ${r.task}`, "", r.error ? `Error: ${r.error}` : "", "```", r.gradeTail.trim() || "(no output)", "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}
