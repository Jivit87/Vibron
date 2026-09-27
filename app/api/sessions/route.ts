/**
 * Agent sessions for a workspace (docs/MULTI_SESSION.md).
 *
 *   GET  /api/sessions?repoKey=…  → { sessions, config, running, queued }
 *   POST /api/sessions            { repoKey, title?, model?, conversationId?, mode? }
 *                                 → { session }   (mode "isolated" = own git worktree)
 *   PUT  /api/sessions            { maxConcurrent?, idleTtlMs? } → { config }
 *
 * Listing also sweeps abandoned sessions, so the list a client sees is
 * already clean.
 */

import { getSessionManager, saveSessionConfig, SessionError } from "@/lib/sessions";
import type { SessionListResponse } from "@/lib/sessions/types";

export const runtime = "nodejs";
export const maxDuration = 120;

function failure(error: unknown): Response {
  const status = error instanceof SessionError ? error.status : 500;
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey");
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const manager = await getSessionManager();
  await manager.sweep().catch(() => []);
  const body: SessionListResponse = {
    sessions: manager.list(repoKey),
    config: manager.getConfig(),
    ...manager.load(repoKey),
  };
  return Response.json(body);
}

export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  try {
    const manager = await getSessionManager();
    const session = await manager.create({
      repoKey,
      title: typeof body.title === "string" ? body.title : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      mode: body.mode === "isolated" ? "isolated" : "shared",
    });
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  const body = await readJson(request);
  if (!body) return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  const patch: { maxConcurrent?: number; idleTtlMs?: number } = {};
  if (body.maxConcurrent !== undefined) {
    const n = Number(body.maxConcurrent);
    if (!Number.isFinite(n)) return Response.json({ error: "maxConcurrent must be a number" }, { status: 400 });
    patch.maxConcurrent = n;
  }
  if (body.idleTtlMs !== undefined) {
    const n = Number(body.idleTtlMs);
    if (!Number.isFinite(n)) return Response.json({ error: "idleTtlMs must be a number" }, { status: 400 });
    patch.idleTtlMs = n;
  }
  return Response.json({ config: await saveSessionConfig(patch) });
}
