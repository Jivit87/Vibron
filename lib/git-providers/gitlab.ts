/**
 * GitLab (gitlab.com or self-hosted) as a `GitProvider`, over REST v4.
 *
 *  - Base: `<instance web root>/api/v4`, so a self-hosted instance under a
 *    path prefix (`https://corp.example/gitlab`) works.
 *  - Auth: the `PRIVATE-TOKEN` header (personal, group or project access
 *    token with the `api` scope). git over https gets it as basic auth
 *    `oauth2:<token>` through `GIT_CONFIG_*`, scoped to the instance root.
 *  - Projects are addressed by their URL-encoded full path (`g%2Fsub%2Fp`),
 *    which is how nested groups stay one path parameter.
 *  - Merge requests use their project-scoped `iid` as the "number".
 *  - Drafts: GitLab marks a draft by the `Draft:` title prefix.
 *  - CI: the latest pipeline for the commit, and its jobs.
 */

import { closingReference, itemWebUrl } from "@/lib/git-providers/detect";
import { encodePath, restCall } from "@/lib/git-providers/http";
import {
  extraHeaderEnv,
  GitProviderError,
  remoteUnder,
  unsupported,
  type CiCheckInfo,
  type CommentInfo,
  type CreatePullRequestInput,
  type GitProvider,
  type GitProviderCapabilities,
  type IssueInfo,
  type ItemLocator,
  type ProviderOptions,
  type PullRequestInfo,
  type RepoLocator,
} from "@/lib/git-providers/interface";

export const GITLAB_CAPABILITIES: GitProviderCapabilities = {
  draftPullRequests: true,
  issueLabels: true,
  // The branches API can create and delete, not move, a branch.
  updateBranch: false,
  ciStatus: true,
  ciLogs: true,
  ciRerun: true,
};

const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s*-|\[wip\]|wip:)\s*/i;

interface RawMr {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string;
  target_branch: string;
  sha: string | null;
}

interface RawIssue {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  labels: (string | { name?: string })[];
  author: { username?: string } | null;
  user_notes_count?: number;
  created_at: string;
  updated_at: string;
}

interface RawNote {
  id: number;
  body: string;
  system?: boolean;
  author: { username?: string } | null;
}

interface RawJob {
  id: number;
  name: string;
  status: string;
  allow_failure?: boolean;
  web_url: string;
}

function toPr(mr: RawMr): PullRequestInfo {
  const draft = mr.draft === true || mr.work_in_progress === true;
  return {
    number: mr.iid,
    title: draft ? mr.title.replace(DRAFT_PREFIX, "") : mr.title,
    body: mr.description ?? "",
    url: mr.web_url,
    state: mr.state === "opened" ? "open" : mr.state === "merged" ? "merged" : "closed",
    draft,
    headBranch: mr.source_branch,
    headSha: mr.sha ?? "",
    baseBranch: mr.target_branch,
  };
}

function toIssue(i: RawIssue): IssueInfo {
  return {
    number: i.iid,
    title: i.title,
    body: i.description ?? "",
    url: i.web_url,
    state: i.state === "closed" ? "closed" : "open",
    labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    author: i.author?.username ?? null,
    comments: i.user_notes_count ?? 0,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

/** GitLab job status → check-run status + conclusion. */
export function mapJobStatus(job: Pick<RawJob, "status" | "allow_failure">): Pick<CiCheckInfo, "status" | "conclusion"> {
  switch (job.status) {
    case "running":
      return { status: "in_progress", conclusion: null };
    case "success":
      return { status: "completed", conclusion: "success" };
    case "failed":
      // An allowed failure does not fail the pipeline.
      return { status: "completed", conclusion: job.allow_failure ? "neutral" : "failure" };
    case "canceled":
    case "canceling":
      return { status: "completed", conclusion: "cancelled" };
    case "skipped":
    case "manual":
      return { status: "completed", conclusion: "skipped" };
    default:
      // created, pending, preparing, scheduled, waiting_for_resource, waiting_for_callback
      return { status: "queued", conclusion: null };
  }
}

export class GitLabProvider implements GitProvider {
  readonly platform = "gitlab" as const;
  readonly capabilities = GITLAB_CAPABILITIES;
  private readonly api: string;
  private readonly project: string;

  constructor(
    readonly repo: RepoLocator,
    private readonly token: string | null,
    private readonly options: ProviderOptions = {},
  ) {
    this.api = `${repo.baseUrl}/api/v4`;
    this.project = encodeURIComponent(`${repo.owner}/${repo.repo}`);
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private call<T>(method: string, pathname: string, body?: unknown, raw = false): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Viberon" };
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;
    return restCall<T>(
      "gitlab",
      { method, url: `${this.api}${pathname}`, headers, body, raw },
      { ...this.options, authenticated: this.authenticated, describe: pathname.split("?")[0]! },
    );
  }

  private get p(): string {
    return `/projects/${this.project}`;
  }

  async getDefaultBranch(): Promise<string> {
    const project = await this.call<{ default_branch?: string | null }>("GET", this.p);
    if (!project.default_branch) {
      throw new GitProviderError("The GitLab project has no default branch (is it empty?).", 409, "gitlab");
    }
    return project.default_branch;
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return toPr(await this.call<RawMr>("GET", `${this.p}/merge_requests/${number}`));
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const params = new URLSearchParams({ state: "opened", source_branch: branch });
    const list = await this.call<RawMr[]>("GET", `${this.p}/merge_requests?${params}`);
    return list[0] ? toPr(list[0]) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    const draft = input.draft ?? true;
    return toPr(
      await this.call<RawMr>("POST", `${this.p}/merge_requests`, {
        source_branch: input.head,
        target_branch: input.base,
        title: draft ? `Draft: ${input.title.replace(DRAFT_PREFIX, "")}` : input.title,
        description: input.body,
      }),
    );
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequestInfo> {
    const update: Record<string, string> = {};
    if (input.title !== undefined) {
      // The title carries the draft flag: keep it on a draft MR.
      const current = await this.getPullRequest(number);
      update.title = current.draft ? `Draft: ${input.title.replace(DRAFT_PREFIX, "")}` : input.title;
    }
    if (input.body !== undefined) update.description = input.body;
    return toPr(await this.call<RawMr>("PUT", `${this.p}/merge_requests/${number}`, update));
  }

  async listIssues(query: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {}): Promise<IssueInfo[]> {
    const params = new URLSearchParams();
    const state = query.state ?? "open";
    if (state !== "all") params.set("state", state === "open" ? "opened" : "closed");
    params.set("order_by", "updated_at");
    params.set("sort", "desc");
    params.set("per_page", String(Math.min(100, Math.max(1, query.limit ?? 50))));
    if (query.labels?.length) params.set("labels", query.labels.join(","));
    return (await this.call<RawIssue[]>("GET", `${this.p}/issues?${params}`)).map(toIssue);
  }

  async getIssue(number: number): Promise<IssueInfo> {
    return toIssue(await this.call<RawIssue>("GET", `${this.p}/issues/${number}`));
  }

  async listIssueComments(number: number, limit = 20): Promise<CommentInfo[]> {
    const params = new URLSearchParams({ sort: "asc", order_by: "created_at", per_page: String(Math.min(100, Math.max(1, limit))) });
    const notes = await this.call<RawNote[]>("GET", `${this.p}/issues/${number}/notes?${params}`);
    return notes.filter((n) => !n.system).map((n) => ({ body: n.body ?? "", author: n.author?.username ?? null }));
  }

  async createComment(target: { kind: "issue" | "pr"; number: number }, body: string): Promise<{ id: string; url: string }> {
    const collection = target.kind === "pr" ? "merge_requests" : "issues";
    const note = await this.call<RawNote>("POST", `${this.p}/${collection}/${target.number}/notes`, { body });
    return { id: String(note.id), url: `${itemWebUrl(this.repo, target.kind, target.number)}#note_${note.id}` };
  }

  async getFileContent(filePath: string, ref?: string): Promise<string | null> {
    const at = ref ?? (await this.getDefaultBranch());
    try {
      return await this.call<string>(
        "GET",
        `${this.p}/repository/files/${encodeURIComponent(filePath.replace(/^\/+/, ""))}/raw?ref=${encodeURIComponent(at)}`,
        undefined,
        true,
      );
    } catch (error) {
      if (error instanceof GitProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async createBranch(name: string, sha: string): Promise<void> {
    await this.call("POST", `${this.p}/repository/branches`, { branch: name, ref: sha });
  }

  async updateBranch(): Promise<void> {
    throw unsupported("gitlab", "moving an existing branch");
  }

  async listChecks(sha: string): Promise<CiCheckInfo[]> {
    const params = new URLSearchParams({ sha, order_by: "id", sort: "desc", per_page: "1" });
    const [pipeline] = await this.call<{ id: number }[]>("GET", `${this.p}/pipelines?${params}`);
    if (!pipeline) return [];
    const jobs = await this.call<RawJob[]>("GET", `${this.p}/pipelines/${pipeline.id}/jobs?per_page=100`);
    return jobs.map((job) => ({ name: job.name, ...mapJobStatus(job), url: job.web_url, jobId: String(job.id) }));
  }

  getCheckLog(jobId: string): Promise<string> {
    return this.call<string>("GET", `${this.p}/jobs/${encodePath(jobId)}/trace`, undefined, true);
  }

  async rerunCheck(jobId: string): Promise<void> {
    await this.call("POST", `${this.p}/jobs/${encodePath(jobId)}/retry`);
  }

  issueUrl(number: number): string {
    return itemWebUrl(this.repo, "issue", number);
  }

  pullRequestUrl(number: number): string {
    return itemWebUrl(this.repo, "pr", number);
  }

  /** GitLab's closing pattern accepts a full project path: `Closes g/sub/p#5`. */
  closingReference(issue: ItemLocator): string {
    return closingReference(issue, this.repo);
  }

  gitAuthEnv(remoteUrl: string): Record<string, string> {
    if (!this.token || !remoteUnder(remoteUrl, this.repo.baseUrl)) return {};
    return extraHeaderEnv(this.repo.baseUrl, "oauth2", this.token);
  }

  secrets(): string[] {
    return this.token ? [this.token] : [];
  }
}
