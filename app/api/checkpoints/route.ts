/**
 * Workspace checkpoints — snapshot before a run, restore in one click.
 *
 *   GET    /api/checkpoints?repoKey=…
 *   POST   /api/checkpoints  { repoKey, label }        → snapshot now
 *   PUT    /api/checkpoints  { repoKey, id }           → restore
 *   DELETE /api/checkpoints?repoKey=…&id=…
 */

import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "@/lib/checkpoints";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey");
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }
  return Response.json({ checkpoints: await listCheckpoints(repoKey) });
}

export async function POST(request: Request) {
  let body: { repoKey?: unknown; label?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }

  const handle = await openWorkspace(repoKey);
  const label =
    typeof body.label === "string" && body.label.trim()
      ? body.label.trim()
      : `Snapshot ${new Date().toLocaleTimeString()}`;

  const checkpoint = await createCheckpoint(handle, label);
  if (!checkpoint) {
    return Response.json(
      { error: "Workspace is too large to snapshot (over 24 MB of text)." },
      { status: 413 },
    );
  }
  return Response.json({
    checkpoint,
    checkpoints: await listCheckpoints(repoKey),
  });
}

export async function PUT(request: Request) {
  let body: { repoKey?: unknown; id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!repoKey || !id) {
    return Response.json({ error: "repoKey and id are required" }, { status: 400 });
  }

  const handle = await openWorkspace(repoKey);
  const result = await restoreCheckpoint(handle, id);
  if (!result) {
    return Response.json({ error: "Checkpoint not found" }, { status: 404 });
  }
  return Response.json({ ok: true, ...result });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey");
  const id = url.searchParams.get("id");
  if (!repoKey || !id) {
    return Response.json({ error: "repoKey and id are required" }, { status: 400 });
  }
  await deleteCheckpoint(repoKey, id);
  return Response.json({ checkpoints: await listCheckpoints(repoKey) });
}
