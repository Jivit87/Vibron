/**
 * Review tools over a diff.
 *
 *   POST /api/review { repoKey, tool, target?, model?, task? }
 *     tool:   "review" | "describe" | "improve" | "learn"
 *     target: "working" | "staged" | { base } | { prUrl }   (see lib/review/target.ts)
 *   → { tool, model, result, files?: { included, omitted } }
 *
 * "learn" ignores the target: it reads the repo's past PR review comments
 * (origin must be a GitHub remote) and writes convention notes to memory.
 * Local diffs come from `lib/git` (execFile, no shell); a PR's diff comes
 * from the GitHub REST API.
 */

import { ensureModelReady, MissingCredentialError } from "@/lib/ai";
import { configuredRemoteUrl, GitCommandError } from "@/lib/git";
import { GitHubApiError, parseRemote } from "@/lib/github-api";
import {
  compressDiff,
  DEFAULT_DIFF_BUDGET,
  describeDiff,
  diffForTarget,
  improveDiff,
  isPrTarget,
  learnReviewStyle,
  parseReviewTarget,
  reviewDiff,
  reviewModel,
  ReviewOutputError,
  ReviewTargetError,
} from "@/lib/review";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 180;

const TOOLS = ["review", "describe", "improve", "learn"] as const;
type Tool = (typeof TOOLS)[number];
class BadRequest extends Error {}

async function originRepo(root: string) {
  const origin = await configuredRemoteUrl(root);
  const repo = origin ? parseRemote(origin) : null;
  if (!repo) throw new BadRequest("Learning review style needs a GitHub remote named origin.");
  return repo;
}

function fail(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BadRequest || error instanceof ReviewTargetError) return Response.json({ error: message }, { status: 400 });
  if (error instanceof MissingCredentialError) return Response.json({ error: message, code: "missing_credential" }, { status: 400 });
  if (error instanceof GitHubApiError) {
    return Response.json({ error: message }, { status: error.status >= 400 && error.status < 500 ? error.status : 502 });
  }
  if (error instanceof GitCommandError) return Response.json({ error: message }, { status: 409 });
  if (error instanceof ReviewOutputError) return Response.json({ error: message }, { status: 502 });
  return Response.json({ error: message || "review failed" }, { status: 500 });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return Response.json({ error: "Body must be a JSON object" }, { status: 400 });

  try {
    if (typeof body.repoKey !== "string" || !body.repoKey) throw new BadRequest("repoKey is required");
    if (!TOOLS.includes(body.tool as Tool)) throw new BadRequest(`tool must be one of ${TOOLS.join(", ")}`);
    const tool = body.tool as Tool;
    const target = tool === "learn" ? null : parseReviewTarget(body.target);
    const task = typeof body.task === "string" ? body.task : undefined;
    const root = (await openWorkspace(body.repoKey)).rootPath;
    if (!root && (tool === "learn" || (target && !isPrTarget(target)))) {
      throw new BadRequest("This workspace has no folder on disk.");
    }

    const model = await reviewModel(typeof body.model === "string" ? body.model : undefined);
    await ensureModelReady(model);

    if (tool === "learn") {
      const result = await learnReviewStyle({ root: root!, repo: await originRepo(root!), model, signal: request.signal });
      return Response.json({ tool, model, result });
    }

    const diff = await diffForTarget(root, target!, { signal: request.signal });
    if (!diff.trim()) throw new BadRequest("No changes to review for this target.");
    const { included, omitted } = compressDiff(diff, DEFAULT_DIFF_BUDGET);
    if (!included.length) throw new BadRequest("The diff has no added or changed code to review.");

    const common = { diff, task, model, signal: request.signal };
    const result =
      tool === "review"
        ? await reviewDiff({ ...common, root: root ?? undefined })
        : tool === "describe"
          ? await describeDiff(common)
          : await improveDiff(common);
    return Response.json({ tool, model, result, files: { included, omitted } });
  } catch (error) {
    return fail(error);
  }
}
