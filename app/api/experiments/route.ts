/**
 * Experiments (lib/experiments): fork a task into variant branches, each in
 * its own git worktree, and compare them on the harness's evidence.
 *
 *   GET  /api/experiments?repoKey=…  → { experiments: ExperimentRecord[] }
 *   POST /api/experiments            → 201 { experiment }  (runs in the background)
 *        { repoKey, task?, source?: {kind:"workspace"} | {kind:"plan", versionId}
 *          | {kind:"checkpoint", checkpointId} | {kind:"ref", ref},
 *          variants: [{ model?, prompt?, plan?, planVersionId?, label? }],
 *          concurrency?, maxTurns?, timeoutSec?, testCmd?, noGate? }
 *
 * Follow progress on GET /api/experiments/:id/events (SSE).
 */

import { listExperiments } from "@/lib/experiments";
import {
  clampInt,
  diskWorkspace,
  errorResponse,
  parseSource,
  parseVariants,
  readJson,
} from "@/lib/experiments/http";
import { startExperiment } from "@/lib/experiments/live";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    const { root } = await diskWorkspace(new URL(request.url).searchParams.get("repoKey"));
    return Response.json({ experiments: await listExperiments(root) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const { root } = await diskWorkspace(body.repoKey);
    const timeoutSec = clampInt(body.timeoutSec, 30, 6 * 3600);
    const experiment = await startExperiment({
      repo: root,
      ...(typeof body.task === "string" && body.task.trim() ? { task: body.task.slice(0, 20_000) } : {}),
      source: parseSource(body.source),
      variants: parseVariants(body.variants),
      concurrency: clampInt(body.concurrency, 1, 4) ?? 2,
      ...(clampInt(body.maxTurns, 1, 200) ? { maxTurns: clampInt(body.maxTurns, 1, 200) } : {}),
      ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 } : {}),
      ...(typeof body.testCmd === "string" && body.testCmd.trim() ? { testCmd: body.testCmd.trim().slice(0, 2000) } : {}),
      noGate: body.noGate === true,
    });
    return Response.json({ experiment }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
