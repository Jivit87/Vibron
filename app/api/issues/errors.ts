import { resolveBitbucket, resolveGitLab } from "@/lib/git-providers/credentials";
import { GitProviderError, PLATFORM_LABEL } from "@/lib/git-providers/interface";
import { GitHubApiError } from "@/lib/github-api";
import { IssuesError } from "@/lib/issues";
import { resolveGithubToken } from "@/lib/workspace/clone";

async function hasCredentials(platform: GitProviderError["platform"]): Promise<boolean> {
  if (platform === "gitlab") return Boolean((await resolveGitLab()).token);
  if (platform === "bitbucket") return Boolean(await resolveBitbucket());
  return Boolean(await resolveGithubToken());
}

/** Shared error mapping for the issues routes. */
export async function issuesError(error: unknown): Promise<Response> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof IssuesError) return Response.json({ error: message, code: error.code }, { status: 400 });
  // Private repos answer 404 (not 401) without credentials.
  if (error instanceof GitHubApiError && [401, 403, 404].includes(error.status) && !(await resolveGithubToken())) {
    return Response.json(
      { error: "GitHub needs a token to read this repository's issues. Add one in Settings → Integrations.", code: "no_token" },
      { status: 401 },
    );
  }
  if (error instanceof GitHubApiError) {
    return Response.json({ error: message }, { status: error.status >= 400 && error.status < 500 ? error.status : 502 });
  }
  if (error instanceof GitProviderError) {
    if ([401, 403, 404].includes(error.status) && !(await hasCredentials(error.platform))) {
      const label = PLATFORM_LABEL[error.platform];
      return Response.json(
        { error: `${label} needs credentials to read this repository's issues. Add them in Settings → Integrations.`, code: "no_token" },
        { status: 401 },
      );
    }
    return Response.json({ error: message }, { status: error.status >= 400 && error.status < 500 ? error.status : 502 });
  }
  return Response.json({ error: message || "issues request failed" }, { status: 500 });
}
