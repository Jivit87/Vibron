/**
 * The one definition of "the diff under review", shared by `POST /api/review`,
 * review tasks and `viberon review`.
 *
 *   "working"  uncommitted changes against HEAD, untracked files included
 *   "staged"   the index against HEAD
 *   { base }   the work tree against the merge base with `base`, untracked
 *              included: what a PR from this branch would contain right now
 *   { prUrl }  a GitHub pull request's diff (REST API)
 *
 * Local diffs go through `lib/git` (execFile, no shell).
 */

import { hasHead, repoState, runGit } from "@/lib/git";
import { isValidBranchName } from "@/lib/git/parse";
import { getPullRequestDiff, parsePrUrl, type ApiOptions } from "@/lib/github-api";

export type ReviewTarget = "working" | "staged" | { base: string } | { prUrl: string };

/** Bad input, as opposed to a git or network failure. */
export class ReviewTargetError extends Error {}

const MAX_UNTRACKED = 40;

/** Validate an untrusted target (request body, CLI flags). */
export function parseReviewTarget(value: unknown): ReviewTarget {
  if (value === "working" || value === "staged") return value;
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (o && typeof o.base === "string") {
    const base = o.base.trim();
    if (!isValidBranchName(base) && !/^[0-9a-f]{7,40}$/i.test(base)) {
      throw new ReviewTargetError("target.base must be a branch name or commit sha");
    }
    return { base };
  }
  if (o && typeof o.prUrl === "string") {
    if (!parsePrUrl(o.prUrl)) throw new ReviewTargetError("target.prUrl must look like https://github.com/owner/repo/pull/123");
    return { prUrl: o.prUrl.trim() };
  }
  throw new ReviewTargetError('target must be "working", "staged", { base } or { prUrl }');
}

export function isPrTarget(target: ReviewTarget): target is { prUrl: string } {
  return typeof target === "object" && "prUrl" in target;
}

export async function diffForTarget(root: string | null, target: ReviewTarget, opts?: ApiOptions): Promise<string> {
  if (isPrTarget(target)) return getPullRequestDiff(parsePrUrl(target.prUrl)!, opts);
  if (!root) throw new ReviewTargetError("Reviewing local changes needs a workspace on disk.");
  if (!(await repoState(root)).isRepo) throw new ReviewTargetError("Not a git repository");

  const args = ["diff", "--no-ext-diff", "--no-color", "-U3"];
  if (target === "staged") args.push("--cached");
  else if (target === "working") {
    if (await hasHead(root)) args.push("HEAD");
  } else args.push("--merge-base", target.base);
  const tracked = (await runGit(root, [...args, "--"], { timeoutMs: 60_000 })).stdout;
  return target === "staged" ? tracked : tracked + (await untrackedDiff(root));
}

/** New files are most of a change's code; `git diff <ref>` alone omits them. */
async function untrackedDiff(root: string): Promise<string> {
  const listed = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { timeoutMs: 30_000 });
  const files = listed.stdout
    .split("\0")
    .filter((f) => f && !f.startsWith(".viberon/"))
    .slice(0, MAX_UNTRACKED);
  let out = "";
  for (const file of files) {
    // --no-index exits 1 when the files differ, which is always the case here.
    const { stdout } = await runGit(root, ["diff", "--no-index", "--no-color", "-U3", "--", "/dev/null", file], {
      timeoutMs: 30_000,
      allowFailure: true,
    });
    out += stdout;
  }
  return out;
}
