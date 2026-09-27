/**
 * The evidence a delivery carries: a checks table (original → patched,
 * verdict) and the files changed. Rendered into the PR body and into the
 * report comment on the issue (Jiffy's "report back" step).
 */

import { DeliverError } from "@/lib/deliver/errors";
import { loadHostConfig } from "@/lib/git-providers/credentials";
import { closingReference, parseIssueItemUrl, parsePullRequestItemUrl, type HostConfig } from "@/lib/git-providers/detect";
import { providerFor, type ResolveOptions } from "@/lib/git-providers/factory";
import { githubRepo } from "@/lib/git-providers/github";
import type { ItemLocator } from "@/lib/git-providers/interface";
import { parseGitHubIssueUrl } from "@/lib/github";
import { parsePrUrl } from "@/lib/github-api";
import type { SolveResult } from "@/lib/harness/solve-types";
import { STATUS_TEXT } from "@/lib/headless/report";
import type { VerificationReport } from "@/lib/verify/types";

export interface EvidenceCheck {
  command: string;
  original: string;
  patched: string;
  verdict: string;
}

export interface DeliveryEvidence {
  status: string;
  filesChanged: string[];
  checks: EvidenceCheck[];
}

function counts(report: VerificationReport | null): string {
  if (!report) return "not run";
  const c = report.counts;
  if (report.timedOut) return "timed out";
  return report.parsed
    ? `${c.passed} passed, ${c.failed + c.errors} failed`
    : report.exitCode === 0
      ? "exit 0"
      : `exit ${report.exitCode}`;
}

/** The evidence of a solve, from its gate. */
export function evidenceFromResult(result: SolveResult): DeliveryEvidence {
  const g = result.gate;
  const checks: EvidenceCheck[] = [];
  if (g.enabled && g.command) {
    const verdict = g.newFailures.length
      ? `${g.newFailures.length} new failure(s)`
      : g.fixed.length
        ? `fixed ${g.fixed.length}, no regressions`
        : g.final && g.final.exitCode === 0
          ? "passes"
          : result.status === "resolved"
            ? "no new failures"
            : "failing";
    checks.push({ command: g.command, original: counts(g.baseline), patched: counts(g.final), verdict });
  }
  return { status: result.status, filesChanged: result.filesChanged, checks };
}

/** Validate client-sent evidence (or derive it from a sent SolveResult); null if neither is usable. */
export function parseEvidence(raw: unknown, result?: unknown): DeliveryEvidence | null {
  const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : "");
  if (raw && typeof raw === "object") {
    const e = raw as Record<string, unknown>;
    if (typeof e.status !== "string" || !Array.isArray(e.filesChanged) || !Array.isArray(e.checks)) return null;
    return {
      status: e.status,
      filesChanged: e.filesChanged.filter((f): f is string => typeof f === "string").slice(0, 200),
      checks: e.checks.slice(0, 20).flatMap((c) =>
        c && typeof c === "object"
          ? [{ command: text(c.command), original: text(c.original), patched: text(c.patched), verdict: text(c.verdict) }]
          : [],
      ),
    };
  }
  const r = result as SolveResult | undefined;
  if (r && typeof r === "object" && typeof r.status === "string" && r.gate && Array.isArray(r.filesChanged)) {
    return evidenceFromResult(r);
  }
  return null;
}

const cell =(text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown: status, checks table, files changed. */
export function renderEvidence(evidence: DeliveryEvidence): string {
  const status = STATUS_TEXT[evidence.status as keyof typeof STATUS_TEXT] ?? evidence.status;
  const lines = [`**Status:** ${status}`, ""];
  if (evidence.checks.length) {
    lines.push(
      "| check | original code | with patch | verdict |",
      "|---|---|---|---|",
      ...evidence.checks.map((c) => `| \`${cell(c.command)}\` | ${cell(c.original)} | ${cell(c.patched)} | ${cell(c.verdict)} |`),
      "",
    );
  } else {
    lines.push("No checks ran for this change.", "");
  }
  lines.push(`**Files changed:** ${evidence.filesChanged.map((f) => `\`${f}\``).join(", ") || "none"}`);
  return lines.join("\n");
}

/** PR title from task text: its first line, capped at 72 chars. */
export function titleFromTask(task: string): string {
  const first = task.trim().split("\n")[0]!.replace(/^#+\s*/, "").trim();
  return (first.length > 72 ? `${first.slice(0, 71)}…` : first) || "Viberon fix";
}

/** A GitHub issue (or PR) URL as before, else a GitLab / Bitbucket issue URL. */
function issueItem(issueUrl: string, hosts?: HostConfig): ItemLocator | null {
  const gh = parseGitHubIssueUrl(issueUrl);
  if (gh) return { repo: githubRepo(gh), kind: "issue", number: gh.number };
  return parseIssueItemUrl(issueUrl, hosts);
}

/**
 * The line that closes the issue on merge, in the host's own form:
 * `Fixes owner/repo#N` (GitHub), `Closes group/project#N` (GitLab), `Fixes #N` (Bitbucket).
 */
function closingLine(issueUrl: string): string {
  const issue = issueItem(issueUrl);
  return issue ? closingReference(issue) : `Fixes ${issueUrl}`;
}

/** Body for the delivery PR. */
export function renderPrBody(input: { summary: string; evidence: DeliveryEvidence; issueUrl?: string }): string {
  return [
    input.summary.trim() || "Change made by Viberon.",
    "",
    "## Evidence",
    "",
    renderEvidence(input.evidence),
    ...(input.issueUrl ? ["", closingLine(input.issueUrl)] : []),
    "",
    "_Opened by Viberon. The checks above ran on the original code and on the patch._",
  ].join("\n");
}

export async function reportOnIssue(
  input: { issueUrl: string; prUrl: string; summary: string; evidence: DeliveryEvidence },
  opts?: ResolveOptions,
): Promise<{ commentUrl: string }> {
  const hosts = opts?.hosts ?? (await loadHostConfig());
  const issue = issueItem(input.issueUrl, hosts);
  if (!issue) throw new DeliverError("issueUrl must be a GitHub, GitLab or Bitbucket issue URL.", "invalid_input", 400);
  if (!parsePrUrl(input.prUrl) && !parsePullRequestItemUrl(input.prUrl, hosts)) {
    throw new DeliverError("prUrl must be a GitHub, GitLab or Bitbucket pull request URL.", "invalid_input", 400);
  }
  const body = [
    `Viberon opened a pull request for this issue: ${input.prUrl}`,
    "",
    input.summary.trim(),
    "",
    renderEvidence(input.evidence),
  ].join("\n");
  const provider = await providerFor(issue.repo, opts);
  const comment = await provider.createComment({ kind: "issue", number: issue.number }, body);
  return { commentUrl: comment.url };
}
