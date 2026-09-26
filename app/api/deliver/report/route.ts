/**
 * POST /api/deliver/report
 *   { issueUrl, prUrl, summary, evidence: { status, filesChanged, checks: {command, original, patched, verdict}[] } }
 *   (or `result`: a SolveResult, from which the evidence is derived)
 *   → 200 { commentUrl }
 *
 * Posts the report comment on the issue: PR link, status, checks table, files.
 */

import { parseEvidence, reportOnIssue } from "@/lib/deliver";
import { errorResponse, jsonBody, str } from "@/lib/deliver/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const issueUrl = str(body.issueUrl);
  const prUrl = str(body.prUrl);
  if (!issueUrl || !prUrl) return Response.json({ error: "issueUrl and prUrl are required" }, { status: 400 });
  const evidence = parseEvidence(body.evidence, body.result);
  if (!evidence) {
    return Response.json(
      { error: "evidence { status, filesChanged, checks } (or the run's result) is required" },
      { status: 400 },
    );
  }
  try {
    return Response.json(await reportOnIssue({ issueUrl, prUrl, summary: str(body.summary).slice(0, 4000), evidence }));
  } catch (error) {
    return errorResponse(error);
  }
}
