/**
 * Clone-to-fix: turn a repo URL, `owner/repo`, or an issue URL (GitHub,
 * GitLab, Bitbucket) into a local, indexed disk workspace.
 *
 * Safety: git runs through `spawn` with an argument vector (never a shell),
 * the URL is validated against an allowlist of forms, arguments can never
 * start with `-`, and prompts are disabled so a private repo fails fast
 * instead of hanging on a credential prompt.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadHostConfig } from "@/lib/git-providers/credentials";
import { cloneUrlFor, detectRemote, parseItemUrl, parseRepoWebUrl, type HostConfig } from "@/lib/git-providers/detect";
import type { GitProvider, RepoLocator } from "@/lib/git-providers/interface";
import { fetchGitHubIssue, parseGitHubIssueUrl, type GitHubIssue } from "@/lib/github";
import { lastIndexStats, registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { bootstrapEnvironment } from "@/lib/workspace/bootstrap";

export interface CloneTarget {
  /** What `git clone` receives. */
  cloneUrl: string;
  /** Owner / workspace; a GitLab namespace keeps its nested groups (`g/sub`). */
  owner: string;
  name: string;
  /** Set when the input was an issue URL (or a GitHub PR URL). */
  issueUrl?: string;
  /** Set for GitLab and Bitbucket repositories (GitHub keeps its original parsing). */
  repo?: RepoLocator;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function cleanName(name: string): string {
  return name.replace(/\.git$/, "");
}

function validSegments(owner: string, name: string): boolean {
  return (
    SEGMENT.test(owner) &&
    SEGMENT.test(name) &&
    !owner.startsWith("-") &&
    !name.startsWith("-") &&
    ![".", ".."].includes(owner) &&
    ![".", ".."].includes(name)
  );
}

/**
 * GitLab / Bitbucket inputs: issue and merge/pull request URLs, repository
 * pages (nested GitLab groups, `/-/tree/…`, `/src/…`), and remotes. https
 * inputs become the canonical https clone URL (dropping a Bitbucket user
 * name); ssh inputs are cloned as given.
 */
function parseHostedTarget(value: string, hosts: HostConfig | undefined): CloneTarget | null {
  const item = parseItemUrl(value, hosts);
  if (item && item.repo.platform !== "github") {
    const { repo } = item;
    return { cloneUrl: cloneUrlFor(repo), owner: repo.owner, name: repo.repo, repo, ...(item.kind === "issue" ? { issueUrl: value } : {}) };
  }
  const remote = detectRemote(value, hosts);
  if (remote && remote.platform !== "github") {
    if (/^https?:/i.test(value) && /^https?:/i.test(remote.baseUrl)) {
      const web = parseRepoWebUrl(value, hosts);
      const repo = web?.repo ?? remote;
      return { cloneUrl: cloneUrlFor(repo), owner: repo.owner, name: repo.repo, repo };
    }
    return { cloneUrl: value, owner: remote.owner, name: remote.repo, repo: remote };
  }
  const web = parseRepoWebUrl(value, hosts);
  if (web && web.repo.platform !== "github") {
    return { cloneUrl: cloneUrlFor(web.repo), owner: web.repo.owner, name: web.repo.repo, repo: web.repo };
  }
  return null;
}

/**
 * Accepts `https://host/owner/name(.git)`, `git@host:owner/name.git`,
 * `ssh://git@host/owner/name`, `owner/name`, GitHub issue/PR URLs, and
 * GitLab (nested groups, self-hosted via `hosts`) and Bitbucket repository,
 * issue and merge/pull request URLs.
 * `file://` and absolute local paths only when `allowLocal` (tests, eval).
 */
export function parseCloneTarget(
  input: string,
  options: { allowLocal?: boolean; hosts?: HostConfig } = {},
): CloneTarget | null {
  const value = input.trim();
  if (!value || value.startsWith("-") || /[\s\0;&|`$<>\\]/.test(value)) return null;

  const issue = parseGitHubIssueUrl(value);
  if (issue) {
    return {
      cloneUrl: `https://github.com/${issue.owner}/${issue.repo}.git`,
      owner: issue.owner,
      name: issue.repo,
      issueUrl: value,
    };
  }

  if (!/^[a-z+]+:\/\/[^/]*:[^/@]*@/i.test(value)) {
    const hosted = parseHostedTarget(value, options.hosts);
    if (hosted) return hosted;
  }

  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (short && !value.startsWith(".")) {
    const [, owner, name] = short;
    if (!validSegments(owner!, cleanName(name!))) return null;
    return { cloneUrl: `https://github.com/${owner}/${cleanName(name!)}.git`, owner: owner!, name: cleanName(name!) };
  }

  const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (scp) {
    const [, , , owner, name] = scp;
    if (!validSegments(owner!, name!)) return null;
    return { cloneUrl: value, owner: owner!, name: name! };
  }

  if (options.allowLocal && (value.startsWith("file://") || path.isAbsolute(value))) {
    const local = value.startsWith("file://") ? value.slice("file://".length) : value;
    const name = cleanName(path.basename(local.replace(/\/+$/, "")));
    if (!SEGMENT.test(name)) return null;
    return { cloneUrl: local, owner: "local", name };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["https:", "ssh:", "http:"].includes(url.protocol) || url.username && url.protocol !== "ssh:") return null;
  if (url.password) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  // github.com/owner/name/tree/branch → owner/name
  const owner = segments[0]!;
  const name = cleanName(segments[1]!);
  if (!validSegments(owner, name)) return null;
  const cloneUrl =
    url.protocol === "ssh:"
      ? value
      : `${url.protocol}//${url.host}/${owner}/${name}${url.hostname === "github.com" ? ".git" : ""}`;
  return { cloneUrl, owner, name };
}

/**
 * The GitHub token for clones and issues: the stored integration token
 * (Settings → Integrations), then `GITHUB_TOKEN`/`GH_TOKEN`, else null.
 */
export async function resolveGithubToken(): Promise<string | null> {
  try {
    const [{ readGithubEntry }, { getGlobalEntries }] = await Promise.all([
      import("@/lib/mcp/github"),
      import("@/lib/mcp/settings"),
    ]);
    const token = readGithubEntry((await getGlobalEntries()).github)?.token?.trim();
    if (token) return token;
  } catch {
    // No settings store (bare headless run): fall through to the environment.
  }
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null;
}

/**
 * Auth for git over https to one host, through `GIT_CONFIG_*` env entries
 * (git ≥ 2.31): never in the URL or argv, so nothing logged can contain it.
 */
export function gitAuthEnv(token: string | null | undefined, cloneUrl: string): Record<string, string> {
  // Only ever sent to github.com: the token must not leak to another host.
  const host = /^https:\/\/(github\.com)\//i.exec(cloneUrl)?.[1];
  if (!token || !host) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

export function reposDir(): string {
  return process.env.VIBERON_REPOS_DIR || path.join(os.homedir(), "Viberon", "repos");
}

export function cloneDestination(target: CloneTarget, base = reposDir()): string {
  // Nested GitLab groups flatten into one directory name.
  return path.join(base, `${target.owner.split("/").join("__")}__${target.name}`);
}

/** Run git with an argv (no shell). Streams stderr/stdout lines to `onLine`. */
export function runGit(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        SSH_ASKPASS: "echo",
        GCM_INTERACTIVE: "never",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let partial = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-64 * 1024);
      partial += text;
      const parts = partial.split(/[\r\n]+/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) options.onLine?.(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 15 * 60_000);
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (partial.trim()) options.onLine?.(partial.trim());
      resolve({ code, output });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

export interface CloneResult {
  rootPath: string;
  reused: boolean;
}

/**
 * Clone into `<reposDir>/<owner>__<name>`, or reuse + fetch an existing
 * clone. `ref` checks out a branch/tag/commit after clone or fetch.
 */
export async function cloneRepository(
  target: CloneTarget,
  options: {
    ref?: string;
    depth?: number;
    baseDir?: string;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    /** GitHub token for https clones (see `gitAuthEnv`). */
    token?: string | null;
    /** Prepared `GIT_CONFIG_*` auth (GitLab / Bitbucket); replaces `token`. */
    authEnv?: Record<string, string>;
  } = {},
): Promise<CloneResult> {
  const dest = cloneDestination(target, options.baseDir);
  const progress = options.onProgress ?? (() => {});
  if (options.ref && (!/^[\w./-]+$/.test(options.ref) || options.ref.startsWith("-"))) {
    throw new Error(`Invalid ref: ${options.ref}`);
  }
  const depth = options.depth && Number.isInteger(options.depth) && options.depth > 0 ? options.depth : undefined;
  const auth = options.authEnv ?? gitAuthEnv(options.token, target.cloneUrl);

  let reused = false;
  if (existsSync(path.join(dest, ".git"))) {
    reused = true;
    progress(`Reusing existing clone at ${dest}; fetching…`);
    const fetch = await runGit(["fetch", "--prune", "origin"], { cwd: dest, signal: options.signal, onLine: progress, env: auth });
    if (fetch.code !== 0) progress("git fetch failed; continuing with the local copy");
  } else {
    await mkdir(path.dirname(dest), { recursive: true });
    progress(`Cloning ${target.cloneUrl} into ${dest}…`);
    const args = ["clone", "--progress"];
    if (depth) args.push("--depth", String(depth));
    if (options.ref && depth) args.push("--branch", options.ref);
    args.push("--", target.cloneUrl, dest);
    const clone = await runGit(args, { signal: options.signal, onLine: progress, env: auth });
    if (clone.code !== 0) {
      const reason = clone.output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      throw new Error(`git clone failed: ${reason || `exit ${clone.code}`}`);
    }
  }

  if (options.ref && !(depth && !reused)) {
    let checkout = await runGit(["checkout", "--detach", options.ref], { cwd: dest, onLine: progress });
    if (checkout.code !== 0) {
      checkout = await runGit(["checkout", "--detach", `origin/${options.ref}`], { cwd: dest, onLine: progress });
    }
    if (checkout.code !== 0) throw new Error(`Could not check out ${options.ref}`);
  }
  return { rootPath: dest, reused };
}

export interface ClonedWorkspace {
  repoKey: string;
  rootPath: string;
  label: string;
  reused: boolean;
  issue?: GitHubIssue;
  setupNotes?: string[];
}

/**
 * The whole clone-to-fix intake: parse → clone/fetch → register the disk
 * workspace (indexes the graph, excludes `.viberon/`) → fetch the issue when
 * the input was an issue URL → optional environment bootstrap.
 */
export async function cloneToWorkspace(
  input: string,
  options: {
    ref?: string;
    depth?: number;
    setup?: boolean;
    allowLocal?: boolean;
    baseDir?: string;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    fetchIssue?: (url: string) => Promise<GitHubIssue>;
    /** Undefined: resolve (stored integration, then env); null: anonymous. */
    token?: string | null;
  } = {},
): Promise<ClonedWorkspace> {
  const hosts = await loadHostConfig().catch((): HostConfig => ({}));
  const target = parseCloneTarget(input, { allowLocal: options.allowLocal, hosts });
  if (!target) throw new Error("Unsupported repository URL. Use https, ssh, owner/repo, or an issue URL.");
  const progress = options.onProgress ?? (() => {});
  // GitLab / Bitbucket: the provider holds the host-scoped credentials. Loaded
  // lazily: the factory itself imports this module.
  let provider: GitProvider | null = null;
  if (target.repo) {
    const { providerFor } = await import("@/lib/git-providers/factory");
    provider = await providerFor(target.repo, options.token === undefined ? {} : { token: options.token });
  }
  const token = provider ? null : options.token === undefined ? await resolveGithubToken() : options.token;
  const authEnv = provider?.gitAuthEnv(target.cloneUrl);
  const { rootPath, reused } = await cloneRepository(target, { ...options, token, authEnv, onProgress: progress });

  progress("Indexing code graph…");
  const label = `${target.owner}/${target.name}`;
  const meta = await registerLocalWorkspace(rootPath, { label });
  const stats = lastIndexStats.get(meta.repoKey);
  if (stats) progress(`Indexed: ${stats.parsed} parsed, ${stats.reused} reused from cache`);

  let issue: GitHubIssue | undefined;
  if (target.issueUrl) {
    progress("Fetching issue…");
    const fetchHosted = async (url: string): Promise<GitHubIssue> => {
      const item = parseItemUrl(url, hosts);
      const found = await provider!.getIssue(item!.number);
      return { title: found.title, body: found.body, url: found.url };
    };
    try {
      issue = await (options.fetchIssue ?? (provider ? fetchHosted : (url: string) => fetchGitHubIssue(url, fetch, token)))(target.issueUrl);
    } catch (error) {
      progress(`Could not fetch the issue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let setupNotes: string[] | undefined;
  if (options.setup) {
    progress("Setting up the environment…");
    setupNotes = await bootstrapEnvironment(rootPath, { onProgress: progress, signal: options.signal, repoKey: meta.repoKey });
  }
  return { repoKey: meta.repoKey, rootPath, label, reused, issue, setupNotes };
}
