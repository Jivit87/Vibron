/**
 * POST /api/sessions/:id/undo — revert this session's file changes only.
 *
 * Body (optional): `{ checkpointId?, force? }`. Without a checkpoint id every
 * run of the session is undone, newest first. Other sessions' files are left
 * alone; a file changed by someone else since the session wrote it comes back
 * in `conflicts` and is not overwritten unless `force` (a file another
 * session holds locked is never touched).
 *
 * → { restored, deleted, conflicts: {path, reason}[], checkpoints }
 */

import { getSessionManager, SessionError } from "@/lib/sessions";
import { undoSession } from "@/lib/sessions/undo";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: { checkpointId?: unknown; force?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  try {
    const manager = await getSessionManager();
    const result = await undoSession(manager, id, {
      checkpointId: typeof body.checkpointId === "string" ? body.checkpointId : undefined,
      force: body.force === true,
    });
    return Response.json(result);
  } catch (error) {
    const status = error instanceof SessionError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
