/**
 * POST /api/agent/approve — answer a pending approval request.
 *
 * Body: `{ approvalId, decision: "allow" | "deny" | "allow_always" }`.
 * The legacy `{ approvalId, approved: boolean }` is still accepted.
 *
 * The agent waiting on this approval is blocked inside a different, still-open
 * request; resolving here unblocks it.
 */

import type { ApprovalDecision } from "@/lib/agents/events";
import { resolveApproval } from "@/lib/harness/runs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { approvalId?: unknown; decision?: unknown; approved?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const approvalId = typeof body?.approvalId === "string" ? body.approvalId : "";
  if (!approvalId) {
    return Response.json({ error: "approvalId is required" }, { status: 400 });
  }

  const decision: ApprovalDecision | null =
    body.decision === "allow" || body.decision === "deny" || body.decision === "allow_always"
      ? body.decision
      : typeof body.approved === "boolean"
        ? body.approved
          ? "allow"
          : "deny"
        : null;
  if (!decision) {
    return Response.json(
      { error: 'decision must be "allow", "deny", or "allow_always"' },
      { status: 400 },
    );
  }

  if (!resolveApproval(approvalId, decision)) {
    return Response.json(
      { error: "No pending approval with that id — it may have timed out." },
      { status: 404 },
    );
  }
  return Response.json({ ok: true });
}
