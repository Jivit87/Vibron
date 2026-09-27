/**
 * POST /api/experiments/:id/discard { repoKey, purge? } → { experiment }
 *
 * Stops the experiment if it is running and removes every branch worktree.
 * Evidence bundles stay in `.viberon/experiments/<id>/` unless `purge`.
 * A promoted patch stays in the workspace (undo it with promote {undo:true}).
 */

import { discardExperiment } from "@/lib/experiments";
import { diskWorkspace, errorResponse, readJson } from "@/lib/experiments/http";
import { forgetExperiment } from "@/lib/experiments/live";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = await readJson(request);
    const { root } = await diskWorkspace(body.repoKey);
    const experiment = await discardExperiment({ repo: root, id, purge: body.purge === true });
    forgetExperiment(id);
    return Response.json({ experiment });
  } catch (error) {
    return errorResponse(error);
  }
}
