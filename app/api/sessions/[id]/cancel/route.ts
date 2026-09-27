/**
 * POST /api/sessions/:id/cancel — stop the session's run.
 *
 * A queued run leaves the queue; a running one is cancelled like
 * `/api/agent/cancel` (model streams aborted, approvals denied, terminal
 * sessions killed). The run's own stream then ends with
 * `run_done{status:"cancelled"}`. `ok: false` means there was nothing to stop.
 */

import { getSessionManager, SessionError } from "@/lib/sessions";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const manager = await getSessionManager();
    return Response.json({ ok: manager.cancel(id) });
  } catch (error) {
    const status = error instanceof SessionError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
