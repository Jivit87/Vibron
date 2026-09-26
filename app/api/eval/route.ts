/**
 * GET /api/eval → the latest eval report (eval/results/latest.json):
 *   { generatedAt, model, summary: EvalSummary, rows: EvalRow[] }
 * An empty table when no eval has been run yet (`bin/viberon eval`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const file = path.join(process.env.VIBERON_EVAL_DIR || path.join(process.cwd(), "eval"), "results", "latest.json");
  try {
    return Response.json(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return Response.json({ rows: [] });
  }
}
