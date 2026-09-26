/**
 * POST /api/terminal/input { sessionId, data } → { ok }
 *
 * Writes to a user-started session's stdin (agent sessions have none).
 */

import { writeInput } from "@/lib/terminal";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { sessionId?: unknown; data?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const data = typeof body.data === "string" ? body.data : null;
  if (!sessionId || data === null) {
    return Response.json({ error: "sessionId and data are required" }, { status: 400 });
  }
  if (data.length > 64 * 1024) {
    return Response.json({ error: "Input too large" }, { status: 413 });
  }
  const result = writeInput(sessionId, data);
  if ("error" in result) {
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }
  return Response.json({ ok: true });
}
