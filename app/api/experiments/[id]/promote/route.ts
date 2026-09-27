/**
 * POST /api/experiments/:id/promote { repoKey, branchId }        → { experiment }
 * POST /api/experiments/:id/promote { repoKey, undo: true }      → { experiment }
 *
 * Promote applies the branch's patch to the workspace. A store checkpoint
 * is taken first (restorable from the Changes panel) and the workspace is
 * snapshotted, so `undo` puts it back. 409 when the patch no longer applies
 * or another branch is already promoted.
 */

import { createCheckpoint } from "@/lib/checkpoints";
import { promoteBranch, undoPromotion } from "@/lib/experiments";
import { diskWorkspace, errorResponse, HttpError, readJson } from "@/lib/experiments/http";
import { fullReindex } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await readJson(request);
    const { handle, root } = await diskWorkspace(body.repoKey);
    let experiment;
    if (body.undo === true) {
      experiment = await undoPromotion({ repo: root, id });
    } else {
      if (typeof body.branchId !== "string") throw new HttpError("branchId is required", 400);
      experiment = await promoteBranch({
        repo: root,
        id,
        branchId: body.branchId,
        checkpoint: async () => (await createCheckpoint(handle, `Before promoting experiment ${id.slice(-6)} / ${body.branchId}`))?.id ?? null,
      });
    }
    await fullReindex(handle).catch(() => undefined);
    return Response.json({ experiment });
  } catch (error) {
    return errorResponse(error);
  }
}
