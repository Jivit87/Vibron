/**
 * GET /api/issues/watch?repoKey=                → WatchConfig
 * PUT /api/issues/watch { repoKey, enabled, label, intervalMinutes } → WatchConfig
 * Auto mode: issues carrying the label are fixed and opened as draft PRs.
 */

import { ensureIssueWatchers, getWatch, setWatch, validateWatch, type WatchConfig } from "@/lib/issues/watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const shape = (w: WatchConfig) => ({ ...w, handled: w.handledIssues.length });

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  ensureIssueWatchers();
  return Response.json(shape(await getWatch(repoKey)));
}

export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  try {
    return Response.json(shape(await setWatch(repoKey, validateWatch(body))));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
