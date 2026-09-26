/**
 * POST /api/agent/cancel — stop a run.
 *
 * Body: `{ runId }`. Aborts the run's model streams and tools, denies its
 * pending approvals, and kills its terminal sessions. The run's own stream
 * then ends with `run_done{status:"cancelled"}`. `ok: false` means the run
 * had already finished.
 */

import { cancelRun } from "@/lib/harness/runs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { runId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const runId = typeof body?.runId === "string" ? body.runId : "";
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }
  return Response.json({ ok: cancelRun(runId) });
}
