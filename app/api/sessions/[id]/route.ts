/**
 * One agent session.
 *
 *   GET    /api/sessions/:id   → { session }   (also marks it active, so it is not swept)
 *   PATCH  /api/sessions/:id   { title?, model?, conversationId? } → { session }
 *   DELETE /api/sessions/:id   → { ok }  cancels its run, releases its file locks,
 *                                         removes its worktree (isolated), forgets it
 */

import { getSessionManager, SessionError } from "@/lib/sessions";

export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

function failure(error: unknown): Response {
  const status = error instanceof SessionError ? error.status : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const manager = await getSessionManager();
  const session = manager.get(id);
  if (!session) return Response.json({ error: "Unknown session" }, { status: 404 });
  manager.touch(id);
  return Response.json({ session });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  try {
    const manager = await getSessionManager();
    return Response.json({
      session: manager.update(id, {
        title: body.title,
        model: body.model,
        conversationId: body.conversationId,
      }),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  const manager = await getSessionManager();
  if (!(await manager.delete(id))) return Response.json({ error: "Unknown session" }, { status: 404 });
  return Response.json({ ok: true });
}
