/**
 * PR checks, Open SWE `/baby-sit` style: read the check runs on the PR head,
 * pull the failing Actions job logs down to their failure excerpts, and
 * either seed a fix task (`ciFixTask`) or re-run a job the user says is
 * flaky. A re-run needs written evidence and is capped at 3 per head sha
 * (persisted in the store, so a restart does not reset it).
 *
 * Works on GitHub (check runs, Actions logs and re-runs), GitLab (the
 * commit's latest pipeline and its jobs, with logs and retries) and
 * Bitbucket (commit build statuses; no logs or re-runs through its API).
 */

import { DeliverError } from "@/lib/deliver/errors";
import { loadHostConfig } from "@/lib/git-providers/credentials";
import { parsePullRequestItemUrl } from "@/lib/git-providers/detect";
import { providerFor, type ResolveOptions } from "@/lib/git-providers/factory";
import { githubRepo } from "@/lib/git-providers/github";
import { PLATFORM_LABEL, type GitProvider, type ItemLocator } from "@/lib/git-providers/interface";
import { parsePrUrl } from "@/lib/github-api";
import { getValueRaw, setValueRaw } from "@/lib/store";
import { extractFailures } from "@/lib/verify/extract";

export const MAX_RERUNS_PER_HEAD = 3;
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const MAX_LOGS = 5;

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  logExcerpt?: string;
}

export interface CiStatus {
  headSha: string;
  state: "pending" | "success" | "failure";
  checks: CiCheck[];
}

/** A GitHub PR (URL or `o/r#N`), a GitLab merge request or a Bitbucket pull request. */
async function pullRequestItem(prUrl: string, opts?: ResolveOptions): Promise<ItemLocator> {
  const gh = parsePrUrl(prUrl ?? "");
  if (gh) return { repo: githubRepo(gh), kind: "pr", number: gh.number };
  const item = parsePullRequestItemUrl(prUrl ?? "", opts?.hosts ?? (await loadHostConfig()));
  if (!item) {
    throw new DeliverError(
      "prUrl must be a pull request URL (https://github.com/o/r/pull/N, a GitLab merge request or a Bitbucket pull request).",
      "invalid_input",
      400,
    );
  }
  return item;
}

async function target(prUrl: string, opts?: ResolveOptions): Promise<{ provider: GitProvider; number: number }> {
  const item = await pullRequestItem(prUrl, opts);
  return { provider: await providerFor(item.repo, opts), number: item.number };
}

/**
 * failure if any check failed (so a fix can start before the rest finish),
 * else pending while any runs or none has registered yet, else success.
 */
export async function ciStatus(input: { prUrl: string }, opts?: ResolveOptions): Promise<CiStatus> {
  const { provider, number } = await target(input.prUrl, opts);
  const head = (await provider.getPullRequest(number)).headSha;
  const runs = await provider.listChecks(head);
  let logs = 0;
  const checks = await Promise.all(
    runs.map(async (run): Promise<CiCheck> => {
      const check: CiCheck = { name: run.name, status: run.status, conclusion: run.conclusion, url: run.url };
      const job = provider.capabilities.ciLogs ? run.jobId : null;
      if (run.conclusion && FAILED.has(run.conclusion) && job !== null && logs++ < MAX_LOGS) {
        const log = await provider.getCheckLog(job).catch(() => "");
        const excerpt = log ? extractFailures(log, 3000).trim() : "";
        if (excerpt) check.logExcerpt = excerpt;
      }
      return check;
    }),
  );
  const state = checks.some((c) => c.conclusion && FAILED.has(c.conclusion))
    ? "failure"
    : !checks.length || checks.some((c) => c.status !== "completed")
      ? "pending"
      : "success";
  return { headSha: head, state, checks };
}

/** Task text for "Fix CI": the failing checks and their extracted failures. */
export function ciFixTask(status: CiStatus): string {
  const failed = status.checks.filter((c) => c.conclusion && FAILED.has(c.conclusion));
  if (!failed.length) return "";
  return [
    `CI is failing on this branch (head ${status.headSha.slice(0, 12)}). Fix the code so these checks pass.`,
    "Do not edit .github/workflows or weaken the tests; fix the cause.",
    ...failed.flatMap((c) => [
      "",
      `### ${c.name} (${c.conclusion})`,
      c.url,
      ...(c.logExcerpt ? ["```", c.logExcerpt, "```"] : ["(no log excerpt available)"]),
    ]),
  ].join("\n");
}

interface RerunLedger {
  count: number;
  reruns: { checkName: string; evidence: string; at: number }[];
}

/** GitHub keys keep their original form, so existing ledgers still count. */
const ledgerKey = (provider: GitProvider, sha: string) => {
  const { platform, host, owner, repo } = provider.repo;
  return platform === "github" ? `ci-reruns:${owner}/${repo}@${sha}` : `ci-reruns:${platform}:${host}/${owner}/${repo}@${sha}`;
};

export async function rerunFlaky(
  input: { prUrl: string; checkName: string; evidence: string },
  opts?: ResolveOptions,
): Promise<{ ok: true; attempt: number; remaining: number }> {
  const item = await pullRequestItem(input.prUrl, opts);
  const checkName = input.checkName?.trim();
  const evidence = input.evidence?.trim().replace(/\s+/g, " ").slice(0, 500) ?? "";
  if (!checkName) throw new DeliverError("checkName is required.", "invalid_input", 400);
  if (evidence.length < 10) {
    throw new DeliverError(
      "Evidence is required to re-run a check as flaky: say what in the log shows a transient failure (network timeout, runner lost, …).",
      "no_evidence",
      400,
    );
  }
  const provider = await providerFor(item.repo, opts);
  if (!provider.capabilities.ciRerun) {
    const label = PLATFORM_LABEL[provider.platform];
    throw new DeliverError(`${label} does not support re-running a check through its API; re-run it in ${label}.`, "not_supported", 400);
  }
  const head = (await provider.getPullRequest(item.number)).headSha;
  const key = ledgerKey(provider, head);
  const ledger = (await getValueRaw<RerunLedger>(key)) ?? { count: 0, reruns: [] };
  if (ledger.count >= MAX_RERUNS_PER_HEAD) {
    throw new DeliverError(
      `Flaky re-run limit reached: ${MAX_RERUNS_PER_HEAD} re-runs already for head ${head.slice(0, 12)}. Fix the failure instead.`,
      "rerun_limit",
      429,
    );
  }
  const run = (await provider.listChecks(head)).find((r) => r.name === checkName);
  if (!run) throw new DeliverError(`No check named "${checkName}" on head ${head.slice(0, 12)}.`, "not_found", 404);
  if (run.status !== "completed" || !run.conclusion || !FAILED.has(run.conclusion)) {
    throw new DeliverError(`Check "${checkName}" has not failed; nothing to re-run.`, "not_failed", 409);
  }
  const job = run.jobId;
  if (job === null) {
    const what = provider.platform === "github" ? "a GitHub Actions job" : `a ${PLATFORM_LABEL[provider.platform]} CI job`;
    throw new DeliverError(`Check "${checkName}" is not ${what}; re-run it in its own CI.`, "not_actions", 400);
  }
  await provider.rerunCheck(job);
  const next: RerunLedger = { count: ledger.count + 1, reruns: [...ledger.reruns, { checkName, evidence, at: Date.now() }] };
  await setValueRaw(key, next, 30 * 24 * 3600);
  return { ok: true, attempt: next.count, remaining: MAX_RERUNS_PER_HEAD - next.count };
}
