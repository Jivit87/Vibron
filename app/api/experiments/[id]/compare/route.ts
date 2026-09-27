/**
 * GET /api/experiments/:id/compare?repoKey=…[&patches=1]
 *   → { comparison, patches?: Record<branchId, string> }
 *
 * The branches side by side, best first. With `patches=1`, each finished
 * branch's patch.diff (capped at 200 KB) for a diff view.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { compareExperiment, EXPERIMENTS_DIR, loadExperiment } from "@/lib/experiments";
import { diskWorkspace, errorResponse } from "@/lib/experiments/http";

export const runtime = "nodejs";

const MAX_PATCH = 200 * 1024;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  try {
    const { root } = await diskWorkspace(params.get("repoKey"));
    const experiment = await loadExperiment(root, id);
    const comparison = compareExperiment(experiment);
    if (params.get("patches") !== "1") return Response.json({ comparison });
    const patches: Record<string, string> = {};
    for (const branch of experiment.branches) {
      if (!/^b\d{1,2}$/.test(branch.id) || !branch.evidence) continue;
      const text = await readFile(path.join(root, EXPERIMENTS_DIR, id, branch.id, "patch.diff"), "utf8").catch(() => "");
      patches[branch.id] = text.length > MAX_PATCH ? `${text.slice(0, MAX_PATCH)}\n… (truncated)\n` : text;
    }
    return Response.json({ comparison, patches });
  } catch (error) {
    return errorResponse(error);
  }
}
