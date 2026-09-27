/**
 * The provider for a remote or a URL, with its credentials attached.
 *
 * Credentials are scoped to their host: the GitHub token only ever goes to
 * api.github.com, the GitLab token only to the configured instance (a
 * GitLab-looking host that is not the configured one is used anonymously),
 * Bitbucket credentials only to api.bitbucket.org.
 */

import { BitbucketProvider, type BitbucketAuth } from "@/lib/git-providers/bitbucket";
import { loadHostConfig, resolveBitbucket, resolveGitLab } from "@/lib/git-providers/credentials";
import { detectRemote, normalizeBaseUrl, parseItemUrl, type HostConfig } from "@/lib/git-providers/detect";
import { GitHubProvider } from "@/lib/git-providers/github";
import { GitLabProvider } from "@/lib/git-providers/gitlab";
import type { GitProvider, ItemLocator, ProviderOptions, RepoLocator } from "@/lib/git-providers/interface";
import { resolveGithubToken } from "@/lib/workspace/clone";

export interface ResolveOptions extends ProviderOptions {
  /**
   * Overrides the stored credential for whichever platform the repository
   * is on (GitHub token, GitLab token, Bitbucket access token); null forces
   * anonymous access. Undefined: resolve from Settings, then env.
   */
  token?: string | null;
  /** Host config for detection; default: loaded from Settings. */
  hosts?: HostConfig;
}

/** Explicit credentials, no lookups: for callers (and tests) that already hold them. */
export type ProviderAuth =
  | { platform: "github"; token: string | null }
  | { platform: "gitlab"; token: string | null }
  | { platform: "bitbucket"; auth: BitbucketAuth | null };

export function createProvider(repo: RepoLocator, auth: ProviderAuth, options: ProviderOptions = {}): GitProvider {
  if (repo.platform !== auth.platform) throw new Error(`Credentials for ${auth.platform} cannot be used with a ${repo.platform} repository.`);
  if (auth.platform === "github") {
    return new GitHubProvider(repo, { token: auth.token, fetchImpl: options.fetchImpl, signal: options.signal });
  }
  if (auth.platform === "gitlab") return new GitLabProvider(repo, auth.token, options);
  return new BitbucketProvider(repo, auth.auth, options);
}

async function resolveAuth(repo: RepoLocator, token: string | null | undefined): Promise<ProviderAuth> {
  if (repo.platform === "github") {
    return { platform: "github", token: token === undefined ? await resolveGithubToken() : token };
  }
  if (repo.platform === "gitlab") {
    if (token !== undefined) return { platform: "gitlab", token };
    const configured = await resolveGitLab();
    // The token belongs to one instance; never send it to another host.
    const same = normalizeBaseUrl(configured.baseUrl) === normalizeBaseUrl(repo.baseUrl);
    return { platform: "gitlab", token: same ? configured.token : null };
  }
  if (token !== undefined) return { platform: "bitbucket", auth: token ? { kind: "bearer", token } : null };
  const resolved = await resolveBitbucket();
  if (!resolved) return { platform: "bitbucket", auth: null };
  const auth: BitbucketAuth =
    resolved.kind === "basic"
      ? { kind: "basic", username: resolved.username, password: resolved.password }
      : { kind: "bearer", token: resolved.token };
  return { platform: "bitbucket", auth };
}

/** A provider for a known repository, credentials resolved. */
export async function providerFor(repo: RepoLocator, options: ResolveOptions = {}): Promise<GitProvider> {
  return createProvider(repo, await resolveAuth(repo, options.token), options);
}

/** The provider behind a git remote URL, or null for an unknown host or local path. */
export async function providerForRemote(remoteUrl: string, options: ResolveOptions = {}): Promise<GitProvider | null> {
  const repo = detectRemote(remoteUrl, options.hosts ?? (await loadHostConfig()));
  return repo ? providerFor(repo, options) : null;
}

/** Title, body and URL of an issue or pull/merge request on any platform (the `/api/issue` shape). */
export async function fetchItemSummary(
  url: string,
  options: ResolveOptions = {},
): Promise<{ title: string; body: string; url: string }> {
  const found = await providerForUrl(url, options);
  if (!found) throw new Error(`Not a GitHub, GitLab or Bitbucket issue or pull request URL: ${url}`);
  const { provider, item } = found;
  const data = item.kind === "issue" ? await provider.getIssue(item.number) : await provider.getPullRequest(item.number);
  return { title: data.title, body: data.body, url: data.url };
}

/** The provider and item behind an issue or pull/merge request URL. */
export async function providerForUrl(
  url: string,
  options: ResolveOptions = {},
): Promise<{ provider: GitProvider; item: ItemLocator } | null> {
  const item = parseItemUrl(url, options.hosts ?? (await loadHostConfig()));
  return item ? { provider: await providerFor(item.repo, options), item } : null;
}
