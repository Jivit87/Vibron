/**
 * POST /api/complete { repoKey, path, prefix, suffix, language } → { completion }
 *
 * Inline completion with the fastest configured model. Aborting the request
 * (the editor does on the next keystroke) cancels the model call.
 */

import { complete } from "@/lib/workspace/assist";

export const runtime = "nodejs";

const MAX_CONTEXT = 200_000;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const prefix = str(body.prefix);
  const suffix = str(body.suffix);
  if (!str(body.repoKey) || !str(body.path)) {
    return Response.json({ error: "repoKey and path are required" }, { status: 400 });
  }
  if (prefix.length + suffix.length > MAX_CONTEXT) {
    return Response.json({ error: "Context too large" }, { status: 413 });
  }

  try {
    const completion = await complete(
      { path: str(body.path), language: str(body.language), prefix, suffix },
      { signal: request.signal },
    );
    return Response.json({ completion });
  } catch (error) {
    if (request.signal.aborted) return Response.json({ completion: "" });
    // Completion is best-effort: the editor shows nothing rather than an error.
    return Response.json({
      completion: "",
      error: error instanceof Error ? error.message : "Completion failed",
    });
  }
}
