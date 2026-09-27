/**
 * Detached git worktrees for isolated runs.
 *
 * `viberon run --worktree` and isolated IDE sessions both work in a detached
 * worktree of HEAD under the OS temp dir: the user's checkout, index and
 * branches are never touched, and the change comes back as a patch.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

/** Create a detached worktree of `repo`'s HEAD. Throws when `repo` has no commit. */
export async function createWorktree(repo: string, name: string, flag = "--worktree"): Promise<string> {
  try {
    git(repo, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`${flag} needs a git repository with at least one commit.`);
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "viberon-wt-"));
  const dir = path.join(base, name.replace(/[^\w.-]/g, "_"));
  git(repo, ["worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

/**
 * Remove a worktree created by `createWorktree`, and its temp parent.
 * Returns false when git refused (the directory is still removed).
 */
export async function removeWorktree(repo: string, dir: string): Promise<boolean> {
  let ok = true;
  try {
    git(repo, ["worktree", "remove", "--force", dir]);
  } catch {
    ok = false;
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const parent = path.dirname(dir);
  if (path.basename(parent).startsWith("viberon-wt-")) {
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  }
  if (!ok) {
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // Nothing more to do: the directory is gone, git will prune it later.
    }
  }
  return ok;
}
