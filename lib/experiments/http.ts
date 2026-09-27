/**
 * Request parsing shared by the /api/plans and /api/experiments routes.
 * Nothing from the browser is trusted: ids are pattern-checked, plans are
 * re-normalized, and sizes are capped before anything reaches the engine.
 */

import type { RunPlan } from "@/lib/agents/events";
import { ExperimentError, MAX_VARIANTS, type ExperimentSource, type ExperimentVariant } from "@/lib/experiments";
import { isPlanVersionId, PlanStore, PlanStoreError } from "@/lib/plans/store";
import { openWorkspace, type WorkspaceHandle } from "@/lib/workspace";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The workspace for `repoKey`, which must live on disk. */
export async function diskWorkspace(repoKey: unknown): Promise<{ handle: WorkspaceHandle; root: string }> {
  if (typeof repoKey !== "string" || !repoKey) throw new HttpError("repoKey is required", 400);
  const handle = await openWorkspace(repoKey).catch(() => null);
  if (!handle?.rootPath) {
    throw new HttpError("Plan versions and experiments need a workspace on disk. Open a local folder or clone the repository first.", 400);
  }
  return { handle, root: handle.rootPath };
}

export async function planStoreForRequest(repoKey: unknown): Promise<PlanStore> {
  return new PlanStore((await diskWorkspace(repoKey)).root);
}

/** Map library errors to JSON responses. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ExperimentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof PlanStoreError) {
    const status = error.code === "not_found" ? 404 : error.code === "modified" || error.code === "exists" ? 409 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError("Body must be a JSON object", 400);
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Shape-check a plan from the browser; the engine re-normalizes it. */
export function parsePlanBody(raw: unknown): RunPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const plan = raw as Partial<RunPlan>;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return undefined;
  return {
    summary: typeof plan.summary === "string" ? plan.summary.slice(0, 4000) : "",
    steps: plan.steps.slice(0, 40).filter((s) => s && typeof s === "object"),
    waves: [],
  };
}

export function parseSource(raw: unknown): ExperimentSource {
  if (!raw || typeof raw !== "object") return { kind: "workspace" };
  const source = raw as Record<string, unknown>;
  switch (source.kind) {
    case "workspace":
    case undefined:
      return { kind: "workspace" };
    case "plan":
      if (!isPlanVersionId(source.versionId)) throw new HttpError("source.versionId is not a plan version id", 400);
      return { kind: "plan", versionId: source.versionId };
    case "checkpoint":
      if (typeof source.checkpointId !== "string" || !/^cp_[\w]+$/.test(source.checkpointId)) {
        throw new HttpError("source.checkpointId is not a checkpoint id", 400);
      }
      return { kind: "checkpoint", checkpointId: source.checkpointId };
    case "ref":
      if (typeof source.ref !== "string" || !source.ref) throw new HttpError("source.ref is required", 400);
      return { kind: "ref", ref: source.ref.slice(0, 200) };
    default:
      throw new HttpError("source.kind must be workspace, plan, checkpoint or ref", 400);
  }
}

export function parseVariants(raw: unknown): ExperimentVariant[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError("variants must be a non-empty array", 400);
  if (raw.length > MAX_VARIANTS) throw new HttpError(`At most ${MAX_VARIANTS} variants`, 400);
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new HttpError(`variants[${index}] must be an object`, 400);
    const v = item as Record<string, unknown>;
    const variant: ExperimentVariant = {};
    const label = str(v.label, 60);
    const model = str(v.model, 120);
    const prompt = str(v.prompt, 20_000);
    if (label) variant.label = label;
    if (model) variant.model = model;
    if (prompt) variant.prompt = prompt;
    if (v.planVersionId !== undefined) {
      if (!isPlanVersionId(v.planVersionId)) throw new HttpError(`variants[${index}].planVersionId is not a plan version id`, 400);
      variant.planVersionId = v.planVersionId;
    }
    const plan = parsePlanBody(v.plan);
    if (plan) variant.plan = plan;
    return variant;
  });
}

export function clampInt(raw: unknown, min: number, max: number): number | undefined {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}
