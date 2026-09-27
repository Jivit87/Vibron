/**
 * GitHub as a `GitProvider`: a thin adapter over lib/github-api.ts. Every
 * call goes through the existing client with the same ApiOptions, so the
 * requests (URLs, headers, bodies, error hints) are exactly what delivery,
 * issues and CI sent before the provider layer existed.
 */

import {
  actionsJobId,
  createBranchRef,
  createIssueComment,
  createPullRequest,
  findOpenPullRequest,
  getDefaultBranch,
  getFileContent,
  getIssue,
  getJobLogs,
  getPullRequest,
  listCheckRuns,
  listIssueComments,
  listIssues,
  rerunJob,
  updateBranchRef,
  updatePullRequest,
  type ApiOptions,
  type IssueSummary,
  type PullRequest,
  type RepoId,
} from "@/lib/github-api";
import { closingReference, itemWebUrl } from "@/lib/git-providers/detect";
import type {
  CiCheckInfo,
  CommentInfo,
  CreatePullRequestInput,
  GitProvider,
  GitProviderCapabilities,
  IssueInfo,
  ItemLocator,
  PullRequestInfo,
  RepoLocator,
} from "@/lib/git-providers/interface";
import { gitAuthEnv } from "@/lib/workspace/clone";

export const GITHUB_CAPABILITIES: GitProviderCapabilities = {
  draftPullRequests: true,
  issueLabels: true,
  updateBranch: true,
  ciStatus: true,
  ciLogs: true,
  ciRerun: true,
};

/** A github.com repository from `{ owner, repo }`. */
export function githubRepo(id: RepoId): RepoLocator {
  return { platform: "github", host: "github.com", baseUrl: "https://github.com", owner: id.owner, repo: id.repo };
}

function toPr(pr: PullRequest): PullRequestInfo {
  const merged = Boolean((pr as PullRequest & { merged_at?: string | null }).merged_at);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    url: pr.html_url,
    state: pr.state === "open" ? "open" : merged ? "merged" : "closed",
    draft: pr.draft === true,
    headBranch: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    baseBranch: pr.base?.ref ?? "",
  };
}

function toIssue(i: IssueSummary): IssueInfo {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.html_url,
    state: i.state === "closed" ? "closed" : "open",
    labels: i.labels,
    author: i.author,
    comments: i.comments,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

export class GitHubProvider implements GitProvider {
  readonly platform = "github" as const;
  readonly capabilities = GITHUB_CAPABILITIES;
  private readonly id: RepoId;

  /**
   * `api.token` undefined lets github-api resolve the stored token per call,
   * as before; the factory passes the resolved token.
   */
  constructor(
    readonly repo: RepoLocator,
    private readonly api: ApiOptions = {},
  ) {
    this.id = { owner: repo.owner, repo: repo.repo };
  }

  get authenticated(): boolean {
    return Boolean(this.api.token);
  }

  getDefaultBranch(): Promise<string> {
    return getDefaultBranch(this.id, this.api);
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return toPr(await getPullRequest({ ...this.id, number }, this.api));
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const pr = await findOpenPullRequest(this.id, branch, this.api);
    return pr ? toPr(pr) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    const { title, body, head, base } = input;
    return toPr(await createPullRequest(this.id, { title, body, head, base, draft: input.draft ?? true }, this.api));
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequestInfo> {
    return toPr(await updatePullRequest({ ...this.id, number }, input, this.api));
  }

  async listIssues(query: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {}): Promise<IssueInfo[]> {
    return (await listIssues(this.id, query, this.api)).map(toIssue);
  }

  async getIssue(number: number): Promise<IssueInfo> {
    return toIssue(await getIssue({ ...this.id, number }, this.api));
  }

  async listIssueComments(number: number, limit = 20): Promise<CommentInfo[]> {
    const comments = await listIssueComments({ ...this.id, number }, limit, this.api);
    return comments.map((c) => ({ body: c.body ?? "", author: c.user?.login ?? null }));
  }

  /** Issues and PRs share GitHub's comments endpoint. */
  async createComment(target: { kind: "issue" | "pr"; number: number }, body: string): Promise<{ id: string; url: string }> {
    const comment = await createIssueComment({ ...this.id, number: target.number }, body, this.api);
    return { id: String(comment.id), url: comment.html_url };
  }

  getFileContent(filePath: string, ref?: string): Promise<string | null> {
    return getFileContent(this.id, filePath, ref, this.api);
  }

  createBranch(name: string, sha: string): Promise<void> {
    return createBranchRef(this.id, name, sha, this.api);
  }

  updateBranch(name: string, sha: string, options: { force?: boolean } = {}): Promise<void> {
    return updateBranchRef(this.id, name, sha, options.force === true, this.api);
  }

  async listChecks(sha: string): Promise<CiCheckInfo[]> {
    const runs = await listCheckRuns(this.id, sha, this.api);
    return runs.map((run) => {
      const job = actionsJobId(run);
      return {
        name: run.name,
        // GitHub's own values pass through unchanged.
        status: run.status as CiCheckInfo["status"],
        conclusion: run.conclusion,
        url: run.html_url,
        jobId: job === null ? null : String(job),
      };
    });
  }

  getCheckLog(jobId: string): Promise<string> {
    return getJobLogs(this.id, Number(jobId), this.api);
  }

  rerunCheck(jobId: string): Promise<void> {
    return rerunJob(this.id, Number(jobId), this.api);
  }

  issueUrl(number: number): string {
    return itemWebUrl(this.repo, "issue", number);
  }

  pullRequestUrl(number: number): string {
    return itemWebUrl(this.repo, "pr", number);
  }

  /** `Fixes owner/repo#N`: the form GitHub documents for closing an issue on merge. */
  closingReference(issue: ItemLocator): string {
    return closingReference(issue, this.repo);
  }

  gitAuthEnv(remoteUrl: string): Record<string, string> {
    return gitAuthEnv(this.api.token, remoteUrl);
  }

  secrets(): string[] {
    return this.api.token ? [this.api.token] : [];
  }
}
