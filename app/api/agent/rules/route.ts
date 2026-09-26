/**
 * GET /api/agent/rules?repoKey= — which rules files the next run will load.
 */

import { loadRules } from "@/lib/agents/rules";
import type { RulesResponse } from "@/lib/harness/contracts";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }
  const bundle = await loadRules(await openWorkspace(repoKey));
  const body: RulesResponse = {
    files: bundle.files.map(({ path, source, tokens }) => ({ path, source, tokens })),
  };
  return Response.json(body);
}
