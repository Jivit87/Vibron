/**
 * Uninstall a marketplace server: removes its config entry, deletes its
 * stored secrets and closes any live connection.
 *
 *   POST /api/mcp/marketplace/uninstall { name }
 */

import { bad, currentCatalog, handle, readJson } from "@/lib/mcp/marketplace-http";
import { uninstallServer } from "@/lib/mcp/marketplace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return bad("name is required");
  return handle(async () => {
    const entry = (await currentCatalog()).entries.find((e) => e.id === name);
    await uninstallServer(name, entry);
    return Response.json({ ok: true });
  });
}
