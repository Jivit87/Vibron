/**
 * Workspace checkpoints — snapshot before a run, restore in one click.
 *
 *   GET    /api/checkpoints?repoKey=…
 *   POST   /api/checkpoints  { repoKey, label }        → snapshot now
 *   PUT    /api/checkpoints  { repoKey, id, force? }   → restore
 *
 * A session-scoped checkpoint restores only that session's files and reports
 * `conflicts`. A whole-workspace restore would revert every session's work,
 * so it is refused (409) while any session's run is active in the workspace.
 *   DELETE /api/checkpoints?repoKey=…&id=…
 */

import {
  createCheckpoint,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "@/lib/checkpoints";
import { getSessionManager } from "@/lib/sessions";
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
  let body: { repoKey?: unknown; id?: unknown; force?: unknown };
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

  const checkpoint = await getCheckpoint(id);
  if (checkpoint && checkpoint.scope !== "session") {
    const { running, queued } = (await getSessionManager()).load(repoKey);
    if (running + queued > 0) {
      return Response.json(
        {
          error:
            "Agent sessions are running in this workspace. Restoring a whole-workspace checkpoint would revert their files too; stop them first, or undo a single session instead.",
        },
        { status: 409 },
      );
    }
  }

  const handle = await openWorkspace(repoKey);
  const result = await restoreCheckpoint(handle, id, { force: body.force === true });
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
