/**
 * Enable or disable an installed marketplace server.
 *
 *   POST /api/mcp/marketplace/toggle { name, enabled }
 */

import { bad, handle, readJson } from "@/lib/mcp/marketplace-http";
import { setServerEnabled } from "@/lib/mcp/marketplace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return bad("name is required");
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") return bad("enabled must be a boolean");
  return handle(async () => Response.json({ ok: true, server: await setServerEnabled(name, enabled) }));
}
