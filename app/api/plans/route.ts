/**
 * GET /api/plans?repoKey=…[&limit=n] → { versions: PlanVersionSummary[] }
 *
 * Every plan the orchestrator produced or ran in this workspace, newest
 * first (lib/plans; stored in `.viberon/plans/`).
 */

import { clampInt, errorResponse, planStoreForRequest } from "@/lib/experiments/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const store = await planStoreForRequest(params.get("repoKey"));
    const limit = clampInt(params.get("limit"), 1, 500);
    return Response.json({ versions: await store.list(limit ? { limit } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
