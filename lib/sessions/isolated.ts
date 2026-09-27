/**
 * Isolated sessions: bring a worktree's change back to the main checkout.
 *
 * An isolated session edits a detached worktree of HEAD, so nothing it does
 * is visible in the workspace until the user applies it. Applying is a
 * `git apply` of the worktree's diff against its HEAD (junk and `.viberon/`
 * excluded, the same diff the headless bundle ships as `patch.diff`), after
 * checking that no shared session holds a write lock on any of those files.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runGit } from "@/lib/git";
import { changedFiles, diff, type ChangedFile } from "@/lib/harness/snapshot";
import { lockHolder, lockScope } from "@/lib/sessions/file-locks";
import { SessionError } from "@/lib/sessions/manager";

export interface WorktreeChange {
  files: ChangedFile[];
  patch: string;
}

/** What an isolated session has changed so far, as a git-apply-able patch. */
export async function worktreeChange(worktreeDir: string): Promise<WorktreeChange> {
  const files = await changedFiles(worktreeDir, "HEAD");
  if (files.length === 0) return { files, patch: "" };
  return { files, patch: await diff(worktreeDir, "HEAD") };
}

/**
 * Apply an isolated session's change to the main checkout. Throws a 409
 * `SessionError` when a file is locked by a running shared session or the
 * patch no longer applies (the checkout moved on); nothing is written then.
 */
export async function applyWorktreeChange(input: {
  sessionId: string;
  worktreeDir: string;
  repoRoot: string;
  repoKey: string;
}): Promise<{ files: ChangedFile[] }> {
  const change = await worktreeChange(input.worktreeDir);
  if (change.files.length === 0) return { files: [] };

  const scope = lockScope({ repoKey: input.repoKey, rootPath: input.repoRoot });
  const locked = change.files
    .map((file) => ({ file, holder: lockHolder(scope, file.path) }))
    .filter(({ holder }) => holder && holder.ownerId !== input.sessionId);
  if (locked.length > 0) {
    throw new SessionError(
      `Cannot apply yet: ${locked
        .map(({ file, holder }) => `${file.path} is locked by session "${holder!.label}"`)
        .join("; ")}.`,
      409,
    );
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "viberon-apply-"));
  const patchFile = path.join(dir, "session.patch");
  try {
    await writeFile(patchFile, change.patch.endsWith("\n") ? change.patch : `${change.patch}\n`);
    const args = ["apply", "--binary", "--whitespace=nowarn"];
    const check = await runGit(input.repoRoot, [...args, "--check", patchFile], { allowFailure: true });
    if (check.code !== 0) {
      throw new SessionError(
        `The session's change no longer applies to the workspace: ${(check.stderr || check.stdout).trim().split("\n").slice(0, 4).join(" ")}`,
        409,
      );
    }
    await runGit(input.repoRoot, [...args, patchFile]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { files: change.files };
}
