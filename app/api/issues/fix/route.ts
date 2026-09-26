/**
 * POST /api/issues/fix { repoKey, numbers: number[], deliver?: boolean = true, model? }
 *   → { tasks: Task[], skipped: { number, reason }[] }
 * Queues one fix task per issue. Each runs in its own worktree of
 * origin/<default> and, when its checks prove the fix, opens a draft PR.
 */

import { fixIssues } from "@/lib/issues";
import { issuesError } from "@/app/api/issues/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  if (!Array.isArray(body.numbers) || !body.numbers.every((n) => Number.isInteger(n) && (n as number) > 0)) {
    return Response.json({ error: "numbers must be an array of issue numbers" }, { status: 400 });
  }
  try {
    const result = await fixIssues({
      repoKey,
      numbers: body.numbers as number[],
      deliver: body.deliver !== false,
      source: "ui",
      ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
    });
    return Response.json(result, { status: result.tasks.length ? 201 : 200 });
  } catch (error) {
    return await issuesError(error);
  }
}
