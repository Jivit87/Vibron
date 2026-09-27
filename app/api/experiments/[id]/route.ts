/**
 * GET /api/experiments/:id?repoKey=… → { experiment, comparison, active }
 *
 * The experiment's status: every branch with its state, worktree and
 * evidence, plus the ranked comparison. `active` is true while it runs.
 */

import { compareExperiment, isExperimentActive, loadExperiment } from "@/lib/experiments";
import { diskWorkspace, errorResponse } from "@/lib/experiments/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const { root } = await diskWorkspace(new URL(request.url).searchParams.get("repoKey"));
    const experiment = await loadExperiment(root, id);
    return Response.json({ experiment, comparison: compareExperiment(experiment), active: isExperimentActive(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
