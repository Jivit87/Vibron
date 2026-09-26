/**
 * POST /api/ci/rerun { prUrl, checkName, evidence }
 *   → 200 { ok: true, attempt, remaining }
 *   → 400 no evidence / not an Actions job, 404 unknown check, 409 not failed, 429 limit (3 per head sha)
 */

import { rerunFlaky } from "@/lib/deliver";
import { errorResponse, jsonBody, str } from "@/lib/deliver/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  try {
    return Response.json(
      await rerunFlaky({ prUrl: str(body.prUrl), checkName: str(body.checkName), evidence: str(body.evidence) }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
