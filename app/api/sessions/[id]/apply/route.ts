/**
 * An isolated session's change, and bringing it into the workspace.
 *
 *   GET  /api/sessions/:id/apply → { files: {status, path}[], patch }
 *   POST /api/sessions/:id/apply → { ok, files }   git-applies the worktree's
 *        diff to the workspace checkout. 409 when a file is locked by a
 *        running shared session or the patch no longer applies; nothing is
 *        written then. 400 for a shared session (its edits are already live).
 */

import { getSessionManager, SessionError } from "@/lib/sessions";
import { applyWorktreeChange, worktreeChange } from "@/lib/sessions/isolated";
import { fullReindex, openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 120;

type Context = { params: Promise<{ id: string }> };

async function isolated(id: string) {
  const manager = await getSessionManager();
  const session = manager.get(id);
  if (!session) throw new SessionError("Unknown session", 404);
  const worktree = manager.worktreeOf(id);
  if (!worktree) throw new SessionError("Only isolated sessions have a change to apply.", 400);
  return { manager, session, worktree };
}

function failure(error: unknown): Response {
  const status = error instanceof SessionError ? error.status : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const { worktree } = await isolated(id);
    return Response.json(await worktreeChange(worktree.path));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  try {
    const { manager, session, worktree } = await isolated(id);
    if (session.status === "running" || session.status === "queued" || session.status === "awaiting-approval") {
      throw new SessionError("Wait for the session's run to finish before applying it.", 409);
    }
    const { files } = await applyWorktreeChange({
      sessionId: id,
      worktreeDir: worktree.path,
      repoRoot: worktree.repoRoot,
      repoKey: session.repoKey,
    });
    if (files.length) await fullReindex(await openWorkspace(session.repoKey)).catch(() => null);
    manager.touch(id);
    return Response.json({ ok: true, files });
  } catch (error) {
    return failure(error);
  }
}
