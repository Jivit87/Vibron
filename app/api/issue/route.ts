/**
 * GET /api/issue?url=<issue or PR url> → {title, body, url}
 *
 * GitHub issue / PR URLs, GitLab issues and merge requests (gitlab.com or
 * the configured self-hosted instance), Bitbucket issues and pull requests.
 *
 * Auth: the stored integration credentials for that host (Settings →
 * Integrations), then the env (GITHUB_TOKEN, GITLAB_TOKEN, BITBUCKET_TOKEN),
 * then anonymous. With credentials, private repos work.
 */

import { loadHostConfig } from "@/lib/git-providers/credentials";
import { parseItemUrl } from "@/lib/git-providers/detect";
import { providerFor } from "@/lib/git-providers/factory";
import { GitProviderError } from "@/lib/git-providers/interface";
import { fetchGitHubIssue, GitHubFetchError, parseGitHubIssueUrl } from "@/lib/github";
import { resolveGithubToken } from "@/lib/workspace/clone";

export const runtime = "nodejs";

const failure = (error: unknown) => {
  const notFound =
    (error instanceof GitHubFetchError && error.status === 404) || (error instanceof GitProviderError && error.status === 404);
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: notFound ? 404 : 502 });
};

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (parseGitHubIssueUrl(url)) {
    try {
      return Response.json(await fetchGitHubIssue(url, fetch, await resolveGithubToken()));
    } catch (error) {
      return failure(error);
    }
  }
  const item = parseItemUrl(url, await loadHostConfig());
  if (!item || item.repo.platform === "github") {
    return Response.json({ error: "url must be a GitHub, GitLab or Bitbucket issue or pull request URL" }, { status: 400 });
  }
  try {
    const provider = await providerFor(item.repo);
    const found = item.kind === "issue" ? await provider.getIssue(item.number) : await provider.getPullRequest(item.number);
    return Response.json({ title: found.title, body: found.body, url: found.url });
  } catch (error) {
    return failure(error);
  }
}
