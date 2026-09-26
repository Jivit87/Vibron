/**
 * The GitHub REST calls the review, deliver and CI features need, in one
 * place. The token comes from `resolveGithubToken()` (the GitHub integration
 * in Settings, then GITHUB_TOKEN / GH_TOKEN). It is sent only to
 * api.github.com and never logged.
 *
 * Every function takes an optional `fetchImpl` so tests run offline.
 */

import { resolveGithubToken } from "@/lib/workspace/clone";

const API = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface RepoId {
  owner: string;
  repo: string;
}

export interface PrRef extends RepoId {
  number: number;
}

/** `https://github.com/o/r/pull/12` (any trailing path) or `o/r#12`. */
export function parsePrUrl(value: string): PrRef | null {
  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(value.trim());
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value.trim());
  const m = url ?? short;
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}

/** owner/repo from a git remote URL (https or ssh), github.com only. */
export function parseRemote(remote: string): RepoId | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface ApiOptions {
  token?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

async function call<T>(
  method: string,
  pathname: string,
  body: unknown,
  opts: ApiOptions & { accept?: string; raw?: boolean } = {},
): Promise<T> {
  const token = opts.token === undefined ? await resolveGithubToken() : opts.token;
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.github+json",
    "User-Agent": "Viberon",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await (opts.fetchImpl ?? fetch)(`${API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const message = (() => {
      try {
        return (JSON.parse(detail) as { message?: string }).message ?? detail;
      } catch {
        return detail;
      }
    })();
    const hint =
      response.status === 401
        ? " Check the GitHub token in Settings → Integrations."
        : /rate limit/i.test(message)
          ? token
            ? " GitHub's rate limit for this token is used up; wait for it to reset."
            : " Add a GitHub token in Settings → Integrations (or set GITHUB_TOKEN) for a higher limit."
          : response.status === 403 || response.status === 404
          ? " The token may lack access to this repository."
          : "";
    throw new GitHubApiError(`GitHub ${method} ${pathname} → ${response.status}: ${message.slice(0, 300)}${hint}`, response.status);
  }
  if (opts.raw) return (await response.text()) as T;
  // 204, and 201 with no body (e.g. a job re-run), carry nothing to parse.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ------------------------------ pull requests ----------------------------- */

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export function getPullRequest(pr: PrRef, opts?: ApiOptions): Promise<PullRequest> {
  return call("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, undefined, opts);
}

/** Unified diff of a PR. */
export function getPullRequestDiff(pr: PrRef, opts?: ApiOptions): Promise<string> {
  return call("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, undefined, {
    ...opts,
    accept: "application/vnd.github.v3.diff",
    raw: true,
  });
}

export function findOpenPullRequest(repo: RepoId, branch: string, opts?: ApiOptions): Promise<PullRequest | null> {
  return call<PullRequest[]>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}`,
    undefined,
    opts,
  ).then((list) => list[0] ?? null);
}

export function createPullRequest(
  repo: RepoId,
  input: { title: string; body: string; head: string; base: string; draft?: boolean },
  opts?: ApiOptions,
): Promise<PullRequest> {
  return call("POST", `/repos/${repo.owner}/${repo.repo}/pulls`, input, opts);
}

export function updatePullRequest(
  pr: PrRef,
  input: { title?: string; body?: string },
  opts?: ApiOptions,
): Promise<PullRequest> {
  return call("PATCH", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, input, opts);
}

export function getDefaultBranch(repo: RepoId, opts?: ApiOptions): Promise<string> {
  return call<{ default_branch: string }>("GET", `/repos/${repo.owner}/${repo.repo}`, undefined, opts).then(
    (r) => r.default_branch,
  );
}

export interface ReviewComment {
  body: string;
  path: string;
  user: { login: string } | null;
  created_at: string;
}

/** Recent inline review comments across the repo's PRs, newest first. */
export function listRepoReviewComments(repo: RepoId, limit = 50, opts?: ApiOptions): Promise<ReviewComment[]> {
  const perPage = Math.min(100, Math.max(1, limit));
  return call<ReviewComment[]>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/pulls/comments?sort=created&direction=desc&per_page=${perPage}`,
    undefined,
    opts,
  );
}

/* --------------------------------- issues --------------------------------- */

/** Issues and PRs share the comments endpoint. */
export function createIssueComment(
  issue: PrRef,
  body: string,
  opts?: ApiOptions,
): Promise<{ html_url: string; id: number }> {
  return call("POST", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`, { body }, opts);
}

/* ----------------------------------- CI ----------------------------------- */

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  html_url: string;
  details_url: string | null;
}

export function listCheckRuns(repo: RepoId, sha: string, opts?: ApiOptions): Promise<CheckRun[]> {
  return call<{ check_runs: CheckRun[] }>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?per_page=100`,
    undefined,
    opts,
  ).then((r) => r.check_runs);
}

/** For GitHub Actions the check run id is the job id; other CI providers have none. */
export function actionsJobId(check: CheckRun): number | null {
  return /\/actions\/runs\//.test(`${check.details_url ?? ""} ${check.html_url}`) ? check.id : null;
}

/** Plain-text log of an Actions job (GitHub redirects to a signed URL). */
export function getJobLogs(repo: RepoId, jobId: number, opts?: ApiOptions): Promise<string> {
  return call("GET", `/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/logs`, undefined, { ...opts, raw: true });
}

export function rerunJob(repo: RepoId, jobId: number, opts?: ApiOptions): Promise<void> {
  return call("POST", `/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/rerun`, {}, opts);
}

/* -------------------------------- issue list ------------------------------- */

export interface IssueSummary {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: string[];
  author: string | null;
  comments: number;
  created_at: string;
  updated_at: string;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

function toSummary(i: RawIssue): IssueSummary {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    html_url: i.html_url,
    state: i.state,
    labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    author: i.user?.login ?? null,
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

/** Open issues, newest activity first. The issues endpoint also returns PRs; they are dropped. */
export async function listIssues(
  repo: RepoId,
  query: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {},
  opts?: ApiOptions,
): Promise<IssueSummary[]> {
  const params = new URLSearchParams({
    state: query.state ?? "open",
    sort: "updated",
    direction: "desc",
    per_page: String(Math.min(100, Math.max(1, query.limit ?? 50))),
  });
  if (query.labels?.length) params.set("labels", query.labels.join(","));
  const raw = await call<RawIssue[]>("GET", `/repos/${repo.owner}/${repo.repo}/issues?${params}`, undefined, opts);
  return raw
    .filter((i) => !i.pull_request)
    .map(toSummary);
}

export function getIssue(issue: PrRef, opts?: ApiOptions): Promise<IssueSummary> {
  return call<RawIssue>("GET", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`, undefined, opts).then(toSummary);
}

export function listIssueComments(
  issue: PrRef,
  limit = 20,
  opts?: ApiOptions,
): Promise<{ body: string; user: { login: string } | null }[]> {
  return call("GET", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments?per_page=${Math.min(100, limit)}`, undefined, opts);
}

/** `https://github.com/o/r/issues/12` → { owner, repo, number }. */
export function parseIssueUrl(value: string): PrRef | null {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i.exec(value.trim());
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}
