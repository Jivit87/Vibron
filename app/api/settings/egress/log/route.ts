/**
 * Network egress audit log (read-only).
 *
 *   GET /api/settings/egress/log?repoKey=…&limit=200&decision=deny&source=browse
 *
 * Returns the most recent entries first from `<workspace>/.viberon/egress.log`
 * (or the global log when the workspace has no folder). The log is
 * append-only; there is deliberately no route that edits or clears it.
 */

import { readAudit, type AuditDecision } from "@/lib/egress/audit";
import type { EgressSource } from "@/lib/egress/policy";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const DECISIONS: AuditDecision[] = ["allow", "deny", "ask"];
const SOURCES: EgressSource[] = ["browse", "terminal", "sandbox", "mcp", "provider", "proxy"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const decision = url.searchParams.get("decision") as AuditDecision | null;
  const source = url.searchParams.get("source") as EgressSource | null;
  if (decision && !DECISIONS.includes(decision)) {
    return Response.json({ error: `decision must be one of ${DECISIONS.join(", ")}` }, { status: 400 });
  }
  if (source && !SOURCES.includes(source)) {
    return Response.json({ error: `source must be one of ${SOURCES.join(", ")}` }, { status: 400 });
  }

  const handle = repoKey ? await openWorkspace(repoKey).catch(() => null) : null;
  const entries = await readAudit(handle?.rootPath ?? null, {
    limit: Number.isFinite(limit) ? limit : 200,
    decision: decision ?? undefined,
    source: source ?? undefined,
  });
  return Response.json({ entries });
}
