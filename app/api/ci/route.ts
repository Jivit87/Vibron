/**
 * GET /api/ci?prUrl=<github pr url>
 *   → 200 { headSha, state: "pending"|"success"|"failure", checks: { name, status, conclusion, url, logExcerpt? }[], fixTask }
 *
 * `fixTask` is the "Fix CI" task text (empty unless something failed); send
 * it as `POST /api/tasks { kind: "fix", repoKey, task: fixTask }`.
 */

import { ciFixTask, ciStatus } from "@/lib/deliver";
import { errorResponse } from "@/lib/deliver/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const prUrl = new URL(request.url).searchParams.get("prUrl") ?? "";
  if (!prUrl) return Response.json({ error: "prUrl is required" }, { status: 400 });
  try {
    const status = await ciStatus({ prUrl });
    return Response.json({ ...status, fixTask: ciFixTask(status) });
  } catch (error) {
    return errorResponse(error);
  }
}
