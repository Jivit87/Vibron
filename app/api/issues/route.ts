/**
 * GET /api/issues?repoKey=&label=
 *   → { repo: {owner, repo}, issues: IssueRow[], watch: WatchConfig }
 * Open issues of the workspace's GitHub origin, each with the state of its
 * fix task. See docs/PLAN-ISSUES.md.
 */

import { issueRows } from "@/lib/issues";
import { ensureIssueWatchers, getWatch } from "@/lib/issues/watch";
import { issuesError } from "@/app/api/issues/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey") ?? "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const label = url.searchParams.get("label")?.trim();
  ensureIssueWatchers();
  try {
    const [{ repo, issues }, watch] = await Promise.all([issueRows(repoKey, label ? [label] : []), getWatch(repoKey)]);
    return Response.json({ repo, issues, watch: { ...watch, handled: watch.handledIssues.length } });
  } catch (error) {
    return await issuesError(error);
  }
}
