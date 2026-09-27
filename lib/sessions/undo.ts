/**
 * Per-session undo.
 *
 * Every agent run in a session journals its writes into a session-scoped
 * checkpoint (`lib/checkpoints`). Undoing the session restores those
 * checkpoints newest first, so each file goes back to what it was before the
 * session first touched it. Files written by other sessions are never
 * touched, and a file someone else changed after this session wrote it is
 * reported as a conflict instead of being overwritten.
 */

import { restoreCheckpoint } from "@/lib/checkpoints";
import { SessionError, type SessionManager } from "@/lib/sessions/manager";
import { openWorkspace } from "@/lib/workspace";

export interface UndoResult {
  restored: number;
  deleted: number;
  conflicts: { path: string; reason: string }[];
  checkpoints: string[];
}

export async function undoSession(
  manager: SessionManager,
  id: string,
  options: { checkpointId?: string; force?: boolean } = {},
): Promise<UndoResult> {
  const session = manager.get(id);
  if (!session) throw new SessionError("Unknown session", 404);
  if (session.status === "running" || session.status === "queued" || session.status === "awaiting-approval") {
    throw new SessionError("Stop the session's run before undoing it.", 409);
  }
  const targets = options.checkpointId ? [options.checkpointId] : session.checkpointIds;
  if (options.checkpointId && !session.checkpointIds.includes(options.checkpointId)) {
    throw new SessionError("That checkpoint does not belong to this session.", 404);
  }

  const handle = await openWorkspace(session.worktree?.repoKey ?? session.repoKey);
  const result: UndoResult = { restored: 0, deleted: 0, conflicts: [], checkpoints: [] };
  const conflicted = new Set<string>();
  for (const checkpointId of targets) {
    const restored = await restoreCheckpoint(handle, checkpointId, { force: options.force });
    if (!restored) continue;
    result.restored += restored.restored;
    result.deleted += restored.deleted;
    result.checkpoints.push(checkpointId);
    for (const conflict of restored.conflicts ?? []) {
      if (conflicted.has(conflict.path)) continue;
      conflicted.add(conflict.path);
      result.conflicts.push(conflict);
    }
  }
  manager.touch(id);
  return result;
}
