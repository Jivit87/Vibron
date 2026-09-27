/**
 * GET /api/plans/diff?repoKey=…&a=<version id>&b=<version id>
 *   → { diff: PlanDiff, a: PlanVersion, b: PlanVersion }
 *
 * Structural diff: steps added, removed and changed (by field), and files
 * whose owning step changed.
 */

import { errorResponse, HttpError, planStoreForRequest } from "@/lib/experiments/http";
import { diffPlans } from "@/lib/plans/diff";
import { isPlanVersionId } from "@/lib/plans/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const store = await planStoreForRequest(params.get("repoKey"));
    const [aId, bId] = [params.get("a"), params.get("b")];
    if (!isPlanVersionId(aId) || !isPlanVersionId(bId)) throw new HttpError("a and b must be plan version ids", 400);
    const [a, b] = await Promise.all([store.get(aId), store.get(bId)]);
    return Response.json({ diff: diffPlans(a, b), a, b });
  } catch (error) {
    return errorResponse(error);
  }
}
