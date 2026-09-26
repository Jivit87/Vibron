/**
 * Test an installed marketplace server: start it under a throwaway scope,
 * list its tools, stop it. Bounded by a timeout (default 30s, max 120s).
 *
 *   POST /api/mcp/marketplace/test { name, repoKey?, timeoutMs? }
 */

import { bad, handle, readJson } from "@/lib/mcp/marketplace-http";
import { testServer, TEST_TIMEOUT_MS } from "@/lib/mcp/marketplace";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return bad("name is required");
  const timeoutMs =
    typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 120_000) : TEST_TIMEOUT_MS;
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  // Run where agents would: in the open workspace, so "." means the project.
  const cwd = repoKey ? ((await openWorkspace(repoKey).catch(() => null))?.rootPath ?? null) : null;
  return handle(async () => Response.json(await testServer(name, { cwd, timeoutMs })));
}
