/**
 * Which host, and which repository, a git remote or web URL points at.
 *
 * Remotes: `https://host/path(.git)`, `ssh://[user@]host[:port]/path`,
 * `git+ssh://…`, and scp-style `user@host:path`. Web URLs: repository pages,
 * issues and pull/merge requests of all three platforms.
 *
 * Hosts: github.com, bitbucket.org, gitlab.com, the self-hosted GitLab base
 * URLs configured in Settings (which may carry a path prefix, e.g.
 * `https://git.corp.example/gitlab`), and, for detection only, hostnames that
 * start with `gitlab.`. Credentials are attached later by the factory, and
 * only for the configured instance; detection never implies trust.
 *
 * Pure: no I/O, so the UI, routes and tests share it.
 */

import type { GitPlatform, ItemLocator, RepoLocator } from "@/lib/git-providers/interface";

export interface HostConfig {
  /** Self-hosted GitLab web roots, e.g. `https://gitlab.corp.example` or `https://corp.example/gitlab`. */
  gitlabBaseUrls?: string[];
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function validSegment(s: string): boolean {
  return SEGMENT.test(s) && !s.startsWith("-") && s !== "." && s !== "..";
}

/** `https://Host/x/` → `https://host/x`; null when not an http(s) URL. */
export function normalizeBaseUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
}

interface HostMatch {
  platform: GitPlatform;
  baseUrl: string;
  /** Path prefix of a self-hosted instance ("" or "/gitlab"). */
  prefix: string;
}

function configuredGitLab(hostname: string, hosts: HostConfig | undefined, port = ""): HostMatch[] {
  const out: HostMatch[] = [];
  for (const raw of hosts?.gitlabBaseUrls ?? []) {
    const base = normalizeBaseUrl(raw);
    if (!base) continue;
    const url = new URL(base);
    if (url.hostname !== hostname) continue;
    if (port && url.port && url.port !== port) continue;
    out.push({ platform: "gitlab", baseUrl: base, prefix: url.pathname.replace(/\/+$/, "") });
  }
  // Longest prefix first, so `/gitlab` wins over the bare host.
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/** Platform candidates for a hostname, most specific first. */
function hostMatches(hostname: string, hosts: HostConfig | undefined, port = ""): HostMatch[] {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  if (h === "github.com") return [{ platform: "github", baseUrl: "https://github.com", prefix: "" }];
  if (h === "bitbucket.org") return [{ platform: "bitbucket", baseUrl: "https://bitbucket.org", prefix: "" }];
  if (h === "gitlab.com") return [{ platform: "gitlab", baseUrl: "https://gitlab.com", prefix: "" }];
  const configured = configuredGitLab(h, hosts, port);
  if (configured.length) return configured;
  if (/^gitlab\./.test(h)) return [{ platform: "gitlab", baseUrl: `https://${h}`, prefix: "" }];
  return [];
}

function stripPrefix(pathname: string, prefix: string): string | null {
  if (!prefix) return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}

function splitPath(pathname: string): string[] {
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean);
}

/** owner/repo from path segments; GitLab keeps nested groups in `owner`. */
function locate(match: HostMatch, host: string, segments: string[]): RepoLocator | null {
  const parts = [...segments];
  if (!parts.length) return null;
  parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/, "");
  if (match.platform === "gitlab" ? parts.length < 2 : parts.length !== 2) return null;
  if (!parts.every(validSegment)) return null;
  return {
    platform: match.platform,
    host: host.toLowerCase().replace(/^www\./, ""),
    baseUrl: match.baseUrl,
    owner: parts.slice(0, -1).join("/"),
    repo: parts[parts.length - 1]!,
  };
}

const SCP = /^([A-Za-z0-9_.+-]+)@([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/;

/**
 * The repository behind a git remote URL, or null for local paths, unknown
 * hosts and malformed input.
 */
export function detectRemote(remote: string, hosts?: HostConfig): RepoLocator | null {
  const value = remote.trim();
  if (!value || value.startsWith("-") || /[\s\0]/.test(value)) return null;

  const scp = SCP.exec(value);
  if (scp) {
    const [, , host, pathPart] = scp;
    // ssh paths are relative to the instance root: no web path prefix.
    for (const match of hostMatches(host!, hosts)) {
      const found = locate(match, host!, splitPath(`/${pathPart!.replace(/^\/+/, "")}`));
      if (found) return found;
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const protocol = url.protocol;
  if (!["https:", "http:", "ssh:", "git+ssh:", "ssh+git:", "git:"].includes(protocol)) return null;
  const web = protocol === "https:" || protocol === "http:";
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  for (const match of hostMatches(url.hostname, hosts, web ? url.port : "")) {
    const rest = web ? stripPrefix(pathname, match.prefix) : pathname;
    if (rest === null) continue;
    const found = locate(match, url.hostname, splitPath(rest));
    if (found) return found;
  }
  return null;
}

/* ------------------------------- web URLs --------------------------------- */

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Candidates for a web URL; any host with a GitLab `/-/` path counts as GitLab. */
function webMatches(url: URL, hosts: HostConfig | undefined, pathname: string): HostMatch[] {
  const known = hostMatches(url.hostname, hosts, url.port);
  if (known.length) return known;
  if (/\/-\/(issues|merge_requests|work_items|tree|blob)\b/.test(pathname)) {
    return [{ platform: "gitlab", baseUrl: `${url.protocol}//${url.host.toLowerCase()}`, prefix: "" }];
  }
  return [];
}

const GITHUB_ITEM = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;
const BITBUCKET_ITEM = /^\/([^/]+)\/([^/]+)\/(issues|pull-requests)\/(\d+)(?:\/.*)?$/;
// `-/` is the modern form; the legacy form without it still redirects.
const GITLAB_ITEM = /^\/(.+?)\/(?:-\/)?(issues|merge_requests|work_items)\/(\d+)(?:\/.*)?$/;

/**
 * An issue or pull/merge request URL on any of the three platforms:
 *   https://github.com/o/r/issues/5, …/pull/7[/files]
 *   https://gitlab.com/g/sub/p/-/issues/5, …/-/merge_requests/7, …/-/work_items/5
 *   https://bitbucket.org/ws/r/issues/5[/slug], …/pull-requests/7[/diff]
 */
export function parseItemUrl(value: string, hosts?: HostConfig): ItemLocator | null {
  const url = webUrl(value);
  if (!url) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
  for (const match of webMatches(url, hosts, pathname)) {
    const rest = stripPrefix(pathname, match.prefix);
    if (rest === null) continue;
    const re = match.platform === "github" ? GITHUB_ITEM : match.platform === "bitbucket" ? BITBUCKET_ITEM : GITLAB_ITEM;
    const m = re.exec(rest);
    if (!m) continue;
    const segments = match.platform === "gitlab" ? m[1]!.split("/") : [m[1]!, m[2]!];
    const kindWord = match.platform === "gitlab" ? m[2]! : m[3]!;
    const number = Number(match.platform === "gitlab" ? m[3] : m[4]);
    const repo = locate(match, url.hostname, segments);
    if (!repo || !Number.isSafeInteger(number) || number <= 0) continue;
    const kind = /^(pull|pull-requests|merge_requests)$/.test(kindWord) ? "pr" : "issue";
    return { repo, kind, number };
  }
  return null;
}

/** An issue URL (not a PR) on any platform. */
export function parseIssueItemUrl(value: string, hosts?: HostConfig): ItemLocator | null {
  const item = parseItemUrl(value, hosts);
  return item?.kind === "issue" ? item : null;
}

/** A pull/merge request URL on any platform. */
export function parsePullRequestItemUrl(value: string, hosts?: HostConfig): ItemLocator | null {
  const item = parseItemUrl(value, hosts);
  return item?.kind === "pr" ? item : null;
}

/**
 * A repository page URL (`https://gitlab.com/g/sub/p/-/tree/main`,
 * `https://bitbucket.org/ws/r/src/main/`, `https://github.com/o/r/tree/x`)
 * → the repository and the ref it names, if any.
 */
export function parseRepoWebUrl(value: string, hosts?: HostConfig): { repo: RepoLocator; ref?: string } | null {
  const url = webUrl(value);
  if (!url || url.username || url.password) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
  for (const match of webMatches(url, hosts, pathname)) {
    const rest = stripPrefix(pathname, match.prefix);
    if (rest === null) continue;
    const segments = splitPath(rest);
    let repoSegments: string[];
    let ref: string | undefined;
    if (match.platform === "gitlab") {
      const dash = segments.indexOf("-");
      repoSegments = dash === -1 ? segments : segments.slice(0, dash);
      if (dash !== -1 && segments[dash + 1] === "tree" && segments.length > dash + 2) ref = segments.slice(dash + 2).join("/");
    } else {
      repoSegments = segments.slice(0, 2);
      const marker = match.platform === "github" ? "tree" : "src";
      if (segments[2] === marker && segments.length > 3) ref = segments.slice(3).join("/");
    }
    const repo = locate(match, url.hostname, repoSegments);
    if (repo) return ref ? { repo, ref } : { repo };
  }
  return null;
}

/** The https clone URL of a repository. */
export function cloneUrlFor(repo: RepoLocator): string {
  return `${repo.baseUrl}/${repo.owner}/${repo.repo}.git`;
}

/**
 * The PR-body line that closes `issue` when the PR (in `prRepo`, default the
 * issue's own repository) merges:
 *   GitHub     `Fixes owner/repo#N`
 *   GitLab     `Closes group/sub/project#N` (full path works across projects)
 *   Bitbucket  `Fixes #N` (same repository only; otherwise the issue URL)
 */
export function closingReference(issue: ItemLocator, prRepo: RepoLocator = issue.repo): string {
  const { repo, number } = issue;
  if (repo.platform === "github") return `Fixes ${repo.owner}/${repo.repo}#${number}`;
  if (repo.platform === "gitlab") return `Closes ${repo.owner}/${repo.repo}#${number}`;
  const same = prRepo.platform === "bitbucket" && prRepo.owner === repo.owner && prRepo.repo === repo.repo;
  return same ? `Fixes #${number}` : `Fixes ${itemWebUrl(repo, "issue", number)}`;
}

/** Web URL of an issue or PR, in each platform's canonical form. */
export function itemWebUrl(repo: RepoLocator, kind: "issue" | "pr", number: number): string {
  const root = `${repo.baseUrl}/${repo.owner}/${repo.repo}`;
  if (repo.platform === "github") return `${root}/${kind === "pr" ? "pull" : "issues"}/${number}`;
  if (repo.platform === "gitlab") return `${root}/-/${kind === "pr" ? "merge_requests" : "issues"}/${number}`;
  return `${root}/${kind === "pr" ? "pull-requests" : "issues"}/${number}`;
}
