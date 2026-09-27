/**
 * GET /api/plans/:id?repoKey=…
 *   → { version, outcomes: PlanRunOutcome[], lineage: {id, origin, createdAt}[], children: PlanVersionSummary[] }
 *
 * One immutable plan version, every recorded run of it, its ancestors
 * (newest first, itself included) and the versions derived from it.
 */

import { errorResponse, planStoreForRequest } from "@/lib/experiments/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const store = await planStoreForRequest(new URL(request.url).searchParams.get("repoKey"));
    const version = await store.get(id);
    const [outcomes, lineage, children] = await Promise.all([store.outcomes(id), store.lineage(id), store.children(id)]);
    return Response.json({
      version,
      outcomes,
      lineage: lineage.map((v) => ({ id: v.id, origin: v.origin, createdAt: v.createdAt })),
      children,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
