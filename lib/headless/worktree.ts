/**
 * Detached git worktrees for isolated runs.
 *
 * `viberon run --worktree`, isolated IDE sessions and experiment branches
 * all work in a detached worktree under the OS temp dir: the user's
 * checkout, index and branches are never touched, and the change comes back
 * as a patch.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

export interface WorktreeOptions {
  /**
   * A tree (or commit) to materialize instead of HEAD: e.g. a `snapshot()`
   * of the work tree, so uncommitted changes come along. Its objects must be
   * in the repository (snapshots of the repo are).
   */
  baseTree?: string;
  /**
   * Symlink the repo's git-ignored dependency directories (node_modules,
   * .venv, venv) into the worktree so its checks can run without a fresh
   * install. Ignored paths never enter a snapshot or a patch.
   */
  linkDependencies?: boolean;
  /** Who is asking, for the "needs a git repository" error. Default `--worktree`. */
  label?: string;
}

const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv"]);

/**
 * Create a detached worktree of `repo`'s HEAD (or of `baseTree`) in a fresh
 * temporary directory. Throws when `repo` has no commit.
 */
export async function createWorktree(repo: string, name: string, options: WorktreeOptions = {}): Promise<string> {
  try {
    git(repo, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`${options.label ?? "--worktree"} needs a git repository with at least one commit.`);
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "viberon-wt-"));
  const dir = path.join(base, name.replace(/[^\w.-]/g, "_"));
  git(repo, ["worktree", "add", "--detach", dir, "HEAD"]);
  try {
    if (options.baseTree && options.baseTree !== git(repo, ["rev-parse", "HEAD^{tree}"])) {
      // Index and files both follow the tree; files it lacks are removed.
      git(dir, ["read-tree", "-u", "--reset", options.baseTree]);
    }
    if (options.linkDependencies) linkDependencies(repo, dir);
  } catch (error) {
    await removeWorktree(repo, dir);
    throw error;
  }
  return dir;
}

function linkDependencies(repo: string, dir: string): void {
  let ignored: string[];
  try {
    ignored = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .split("\0")
      .filter(Boolean);
  } catch {
    return;
  }
  for (const raw of ignored) {
    const rel = raw.replace(/\/$/, "");
    if (!DEPENDENCY_DIRS.has(path.basename(rel)) || rel.split("/").length > 3) continue;
    const target = path.join(dir, rel);
    if (existsSync(target)) continue;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(path.join(repo, rel), target);
    } catch {
      // A missing link only means the checks may not find their dependencies.
    }
  }
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
  // Only ever delete a directory this module created (`<tmp>/viberon-wt-*/<name>`).
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
