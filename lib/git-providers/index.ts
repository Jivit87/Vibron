/**
 * Multi-platform git hosting: GitHub, GitLab, Bitbucket behind one
 * `GitProvider` interface. See docs/MULTI_GIT.md.
 */

export * from "@/lib/git-providers/interface";
export * from "@/lib/git-providers/detect";
export { createProvider, fetchItemSummary, providerFor, providerForRemote, providerForUrl, type ProviderAuth, type ResolveOptions } from "@/lib/git-providers/factory";
export { GitHubProvider, githubRepo } from "@/lib/git-providers/github";
export { GitLabProvider } from "@/lib/git-providers/gitlab";
export { BitbucketProvider, type BitbucketAuth } from "@/lib/git-providers/bitbucket";
export { gitCredentialStatus, loadHostConfig, resolveBitbucket, resolveGitLab } from "@/lib/git-providers/credentials";
