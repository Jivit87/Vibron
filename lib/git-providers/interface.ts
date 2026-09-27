/**
 * One interface over the three git hosts Viberon delivers to: GitHub,
 * GitLab (gitlab.com or self-hosted) and Bitbucket Cloud. Delivery, issue
 * intake, CI watch and clone talk to a `GitProvider`; the adapters translate
 * to each REST API. What a platform cannot do is a `false` capability, and
 * the matching method throws `GitProviderError` with code "unsupported".
 *
 * Vocabulary is GitHub's, since the rest of the app already speaks it: a
 * GitLab merge request is a "pull request" here, and CI states are mapped
 * onto check-run status/conclusion values. See docs/MULTI_GIT.md.
 */

export type GitPlatform = "github" | "gitlab" | "bitbucket";

export const PLATFORM_LABEL: Record<GitPlatform, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/** What a platform calls a pull request, for messages. */
export const PR_NOUN: Record<GitPlatform, string> = {
  github: "pull request",
  gitlab: "merge request",
  bitbucket: "pull request",
};

/** A repository on a host. */
export interface RepoLocator {
  platform: GitPlatform;
  /** Hostname, lower case, without port. */
  host: string;
  /** Web root of the instance: `https://gitlab.com`, `https://git.corp.example/gitlab`. */
  baseUrl: string;
  /** GitHub owner, Bitbucket workspace, or GitLab namespace (nested groups joined by "/"). */
  owner: string;
  /** Repository / project slug. */
  repo: string;
}

/** An issue or pull/merge request on a host. */
export interface ItemLocator {
  repo: RepoLocator;
  kind: "issue" | "pr";
  number: number;
}

export interface GitProviderCapabilities {
  /** PRs can be opened as drafts (GitLab: the "Draft:" title prefix). */
  draftPullRequests: boolean;
  /** Issues carry free-form labels (Bitbucket has none; its components stand in). */
  issueLabels: boolean;
  /** A branch ref can be moved to another commit through the API. */
  updateBranch: boolean;
  /** CI state for a commit can be read. */
  ciStatus: boolean;
  /** A failed CI job's log can be read. */
  ciLogs: boolean;
  /** A failed CI job can be re-run. */
  ciRerun: boolean;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headBranch: string;
  /** Head commit; Bitbucket reports an abbreviated hash. */
  headSha: string;
  baseBranch: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed";
  labels: string[];
  author: string | null;
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentInfo {
  body: string;
  author: string | null;
}

/** A CI job / check / commit status, in GitHub check-run terms. */
export interface CiCheckInfo {
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** success, failure, cancelled, skipped, neutral, timed_out, … (GitHub's values); null until completed. */
  conclusion: string | null;
  url: string;
  /** Job id for `getCheckLog` / `rerunCheck`; null when the platform or CI system has none. */
  jobId: string | null;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface GitProvider {
  readonly platform: GitPlatform;
  readonly repo: RepoLocator;
  readonly capabilities: GitProviderCapabilities;
  /** True when credentials are available for this host. */
  readonly authenticated: boolean;

  getDefaultBranch(): Promise<string>;

  getPullRequest(number: number): Promise<PullRequestInfo>;
  /** The open PR whose source branch is `branch`, or null. */
  findOpenPullRequest(branch: string): Promise<PullRequestInfo | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo>;
  /** Title/body only; a draft stays a draft. */
  updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequestInfo>;

  /** Newest activity first; never includes pull requests. */
  listIssues(query?: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number }): Promise<IssueInfo[]>;
  getIssue(number: number): Promise<IssueInfo>;
  /** Human comments, oldest first (system notes are dropped). */
  listIssueComments(number: number, limit?: number): Promise<CommentInfo[]>;
  /** Comment on an issue or a pull request. */
  createComment(target: { kind: "issue" | "pr"; number: number }, body: string): Promise<{ id: string; url: string }>;

  /** A file's text at `ref` (default branch when omitted), or null if absent. */
  getFileContent(path: string, ref?: string): Promise<string | null>;
  createBranch(name: string, sha: string): Promise<void>;
  /** Move a branch to `sha` (requires `capabilities.updateBranch`). */
  updateBranch(name: string, sha: string, options?: { force?: boolean }): Promise<void>;

  /** CI for a commit (requires `capabilities.ciStatus`). */
  listChecks(sha: string): Promise<CiCheckInfo[]>;
  /** Plain-text log of a job (requires `capabilities.ciLogs`). */
  getCheckLog(jobId: string): Promise<string>;
  /** Re-run one job (requires `capabilities.ciRerun`). */
  rerunCheck(jobId: string): Promise<void>;

  /** Web URL of an issue / pull request of this repository. */
  issueUrl(number: number): string;
  pullRequestUrl(number: number): string;
  /** The PR-body line that closes `issue` on merge (`Fixes o/r#5`, `Closes g/p#5`). */
  closingReference(issue: ItemLocator): string;

  /**
   * `GIT_CONFIG_*` env entries that authenticate git over https to this
   * repository's host only; empty for ssh remotes, other hosts or no credentials.
   */
  gitAuthEnv(remoteUrl: string): Record<string, string>;
  /** Every secret string this provider holds, for redacting git output. */
  secrets(): string[];
}

/** A REST failure or a missing capability, with the HTTP status to report. */
export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly platform: GitPlatform,
    readonly code: "api" | "unsupported" | "invalid_input" = "api",
  ) {
    super(message);
    this.name = "GitProviderError";
  }
}

export function unsupported(platform: GitPlatform, what: string): GitProviderError {
  return new GitProviderError(`${PLATFORM_LABEL[platform]} does not support ${what} through its API.`, 400, platform, "unsupported");
}

/** Where a repository's `owner/repo` lives, for display and keys. */
export function repoPath(repo: Pick<RepoLocator, "owner" | "repo">): string {
  return `${repo.owner}/${repo.repo}`;
}

/** Transport options every adapter accepts (tests inject `fetchImpl`). */
export interface ProviderOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * The header git needs to authenticate over https to `prefix`, through env
 * config (git ≥ 2.31): never in the URL or argv.
 */
export function extraHeaderEnv(prefix: string, user: string, secret: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${prefix.replace(/\/+$/, "")}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`,
  };
}

/**
 * True when `remoteUrl` is an https URL under `prefix` (same host and port,
 * path prefix). A user name in the remote is fine (Bitbucket's clone URLs
 * carry one, and git's `http.<url>.*` matching ignores it); an embedded
 * password is not: that remote already leaks a secret, so no second one is added.
 */
export function remoteUnder(remoteUrl: string, prefix: string): boolean {
  let remote: URL;
  let base: URL;
  try {
    remote = new URL(remoteUrl.trim());
    base = new URL(prefix);
  } catch {
    return false;
  }
  if (remote.protocol !== "https:" || base.protocol !== "https:") return false;
  if (remote.password) return false;
  if (remote.host.toLowerCase() !== base.host.toLowerCase()) return false;
  const basePath = base.pathname.replace(/\/+$/, "");
  return remote.pathname === basePath || remote.pathname.startsWith(`${basePath}/`);
}
