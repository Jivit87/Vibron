/**
 * Bitbucket Cloud as a `GitProvider`, over the 2.0 REST API.
 *
 *  - Base: `https://api.bitbucket.org/2.0/repositories/{workspace}/{slug}`.
 *  - Auth, either:
 *      basic  — username + app password (or Atlassian API token), sent as
 *               HTTP basic auth; git uses the same pair.
 *      bearer — a repository / project / workspace access token, sent as
 *               `Authorization: Bearer`; git uses `x-token-auth:<token>`.
 *    git gets it through `GIT_CONFIG_*`, scoped to https://bitbucket.org/.
 *  - Issues come from the repository's built-in issue tracker. It has no
 *    labels: an issue's component (and kind) stand in for them, and a label
 *    filter matches the component name.
 *  - CI: commit build statuses (Bitbucket Pipelines and external CI). Logs and
 *    re-runs are not available through this API.
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

export const BITBUCKET_API = "https://api.bitbucket.org/2.0";
const WEB_ROOT = "https://bitbucket.org";

export const BITBUCKET_CAPABILITIES: GitProviderCapabilities = {
  draftPullRequests: true,
  issueLabels: false,
  updateBranch: false,
  ciStatus: true,
  ciLogs: false,
  ciRerun: false,
};

export type BitbucketAuth =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

const OPEN_STATES = ["new", "open", "on hold"];
const CLOSED_STATES = ["resolved", "closed", "invalid", "duplicate", "wontfix"];

interface RawPr {
  id: number;
  title: string;
  description?: string | null;
  summary?: { raw?: string | null };
  state: string;
  draft?: boolean;
  source: { branch: { name: string }; commit?: { hash: string } | null };
  destination: { branch: { name: string } };
  links: { html?: { href: string } };
}

interface RawUser {
  nickname?: string;
  display_name?: string;
}

interface RawIssue {
  id: number;
  title: string;
  content?: { raw?: string | null };
  state: string;
  kind?: string;
  component?: { name?: string } | null;
  reporter?: RawUser | null;
  links: { html?: { href: string } };
  created_on: string;
  updated_on: string;
}

interface RawComment {
  id: number;
  content?: { raw?: string | null };
  user?: RawUser | null;
  links?: { html?: { href: string } };
}

interface RawStatus {
  key: string;
  name?: string | null;
  state: string;
  url: string;
}

interface Page<T> {
  values: T[];
}

const userName = (u: RawUser | null | undefined) => u?.nickname ?? u?.display_name ?? null;

/** A value inside a BBQL string literal. */
const bbql = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Commit build status → check-run status + conclusion. */
export function mapBuildState(state: string): Pick<CiCheckInfo, "status" | "conclusion"> {
  switch (state) {
    case "SUCCESSFUL":
      return { status: "completed", conclusion: "success" };
    case "FAILED":
      return { status: "completed", conclusion: "failure" };
    case "STOPPED":
      return { status: "completed", conclusion: "cancelled" };
    default:
      return { status: "in_progress", conclusion: null };
  }
}

export class BitbucketProvider implements GitProvider {
  readonly platform = "bitbucket" as const;
  readonly capabilities = BITBUCKET_CAPABILITIES;
  private readonly base: string;

  constructor(
    readonly repo: RepoLocator,
    private readonly auth: BitbucketAuth | null,
    private readonly options: ProviderOptions = {},
  ) {
    this.base = `/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  }

  get authenticated(): boolean {
    return this.auth !== null;
  }

  private call<T>(method: string, pathname: string, body?: unknown, raw = false): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Viberon" };
    if (this.auth?.kind === "basic") {
      headers.Authorization = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;
    } else if (this.auth?.kind === "bearer") {
      headers.Authorization = `Bearer ${this.auth.token}`;
    }
    return restCall<T>(
      "bitbucket",
      { method, url: `${BITBUCKET_API}${pathname}`, headers, body, raw },
      { ...this.options, authenticated: this.authenticated, describe: pathname.split("?")[0]! },
    );
  }

  private toPr(pr: RawPr): PullRequestInfo {
    return {
      number: pr.id,
      title: pr.title,
      body: pr.description ?? pr.summary?.raw ?? "",
      url: pr.links?.html?.href ?? this.pullRequestUrl(pr.id),
      state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
      draft: pr.draft === true,
      headBranch: pr.source?.branch?.name ?? "",
      headSha: pr.source?.commit?.hash ?? "",
      baseBranch: pr.destination?.branch?.name ?? "",
    };
  }

  private toIssue(i: RawIssue): IssueInfo {
    return {
      number: i.id,
      title: i.title,
      body: i.content?.raw ?? "",
      url: i.links?.html?.href ?? this.issueUrl(i.id),
      state: OPEN_STATES.includes(i.state) ? "open" : "closed",
      labels: [i.component?.name, i.kind].filter((l): l is string => Boolean(l)),
      author: userName(i.reporter),
      // The issue object carries no comment count.
      comments: 0,
      createdAt: i.created_on,
      updatedAt: i.updated_on,
    };
  }

  async getDefaultBranch(): Promise<string> {
    const repo = await this.call<{ mainbranch?: { name?: string } | null }>("GET", this.base);
    const name = repo.mainbranch?.name;
    if (!name) throw new GitProviderError("The Bitbucket repository has no main branch (is it empty?).", 409, "bitbucket");
    return name;
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return this.toPr(await this.call<RawPr>("GET", `${this.base}/pullrequests/${number}`));
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestInfo | null> {
    const params = new URLSearchParams({ state: "OPEN", q: `source.branch.name=${bbql(branch)}` });
    const page = await this.call<Page<RawPr>>("GET", `${this.base}/pullrequests?${params}`);
    return page.values?.[0] ? this.toPr(page.values[0]) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    return this.toPr(
      await this.call<RawPr>("POST", `${this.base}/pullrequests`, {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.head } },
        destination: { branch: { name: input.base } },
        draft: input.draft ?? true,
        close_source_branch: false,
      }),
    );
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequestInfo> {
    const update: Record<string, string> = {};
    if (input.title !== undefined) update.title = input.title;
    if (input.body !== undefined) update.description = input.body;
    return this.toPr(await this.call<RawPr>("PUT", `${this.base}/pullrequests/${number}`, update));
  }

  async listIssues(query: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {}): Promise<IssueInfo[]> {
    const clauses: string[] = [];
    const state = query.state ?? "open";
    if (state !== "all") {
      clauses.push(`(${(state === "open" ? OPEN_STATES : CLOSED_STATES).map((s) => `state=${bbql(s)}`).join(" OR ")})`);
    }
    for (const label of query.labels ?? []) clauses.push(`component.name=${bbql(label)}`);
    const params = new URLSearchParams({ sort: "-updated_on", pagelen: String(Math.min(50, Math.max(1, query.limit ?? 50))) });
    if (clauses.length) params.set("q", clauses.join(" AND "));
    const page = await this.call<Page<RawIssue>>("GET", `${this.base}/issues?${params}`);
    return (page.values ?? []).map((i) => this.toIssue(i));
  }

  async getIssue(number: number): Promise<IssueInfo> {
    return this.toIssue(await this.call<RawIssue>("GET", `${this.base}/issues/${number}`));
  }

  async listIssueComments(number: number, limit = 20): Promise<CommentInfo[]> {
    const params = new URLSearchParams({ sort: "created_on", pagelen: String(Math.min(100, Math.max(1, limit))) });
    const page = await this.call<Page<RawComment>>("GET", `${this.base}/issues/${number}/comments?${params}`);
    return (page.values ?? [])
      .filter((c) => c.content?.raw?.trim())
      .map((c) => ({ body: c.content!.raw!, author: userName(c.user) }));
  }

  async createComment(target: { kind: "issue" | "pr"; number: number }, body: string): Promise<{ id: string; url: string }> {
    const collection = target.kind === "pr" ? "pullrequests" : "issues";
    const comment = await this.call<RawComment>("POST", `${this.base}/${collection}/${target.number}/comments`, { content: { raw: body } });
    return {
      id: String(comment.id),
      url: comment.links?.html?.href ?? `${itemWebUrl(this.repo, target.kind, target.number)}#comment-${comment.id}`,
    };
  }

  async getFileContent(filePath: string, ref?: string): Promise<string | null> {
    const at = ref ?? (await this.getDefaultBranch());
    try {
      return await this.call<string>("GET", `${this.base}/src/${encodeURIComponent(at)}/${encodePath(filePath)}`, undefined, true);
    } catch (error) {
      if (error instanceof GitProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async createBranch(name: string, sha: string): Promise<void> {
    await this.call("POST", `${this.base}/refs/branches`, { name, target: { hash: sha } });
  }

  async updateBranch(): Promise<void> {
    throw unsupported("bitbucket", "moving an existing branch");
  }

  async listChecks(sha: string): Promise<CiCheckInfo[]> {
    const page = await this.call<Page<RawStatus>>("GET", `${this.base}/commit/${encodeURIComponent(sha)}/statuses?pagelen=100`);
    return (page.values ?? []).map((s) => ({ name: s.name || s.key, ...mapBuildState(s.state), url: s.url, jobId: null }));
  }

  async getCheckLog(): Promise<string> {
    throw unsupported("bitbucket", "reading CI logs");
  }

  async rerunCheck(): Promise<void> {
    throw unsupported("bitbucket", "re-running a CI job");
  }

  issueUrl(number: number): string {
    return itemWebUrl(this.repo, "issue", number);
  }

  pullRequestUrl(number: number): string {
    return itemWebUrl(this.repo, "pr", number);
  }

  /** Bitbucket links `#N` within the repository; another repository's issue is linked by URL. */
  closingReference(issue: ItemLocator): string {
    return closingReference(issue, this.repo);
  }

  gitAuthEnv(remoteUrl: string): Record<string, string> {
    if (!this.auth || !remoteUnder(remoteUrl, WEB_ROOT)) return {};
    return this.auth.kind === "basic"
      ? extraHeaderEnv(WEB_ROOT, this.auth.username, this.auth.password)
      : extraHeaderEnv(WEB_ROOT, "x-token-auth", this.auth.token);
  }

  secrets(): string[] {
    if (!this.auth) return [];
    return this.auth.kind === "basic" ? [this.auth.password] : [this.auth.token];
  }
}
