/**
 * GET /api/issue?url=<github issue or PR url> → {title, body, url}
 *
 * Auth: the stored GitHub integration token (Settings → Integrations), then
 * GITHUB_TOKEN, then anonymous. With a token, private repos work.
 */

import { fetchGitHubIssue, GitHubFetchError, parseGitHubIssueUrl } from "@/lib/github";
import { resolveGithubToken } from "@/lib/workspace/clone";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!parseGitHubIssueUrl(url)) {
    return Response.json({ error: "url must be a GitHub issue or pull request URL" }, { status: 400 });
  }
  try {
    return Response.json(await fetchGitHubIssue(url, fetch, await resolveGithubToken()));
  } catch (error) {
    const status = error instanceof GitHubFetchError && error.status === 404 ? 404 : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
