/**
 * MCP marketplace catalog.
 *
 *   GET /api/mcp/marketplace[?refresh=1]     → catalog, installed servers, registry status
 *   PUT /api/mcp/marketplace { registryUrl } → set (or clear with "") the remote registry
 *
 * The catalog is the bundled list, merged with the configured registry when
 * it is reachable. Installed servers carry only masked secret fingerprints.
 */

import { CATEGORIES, CATEGORY_LABEL } from "@/lib/mcp/catalog";
import { bad, currentCatalog, handle, readJson } from "@/lib/mcp/marketplace-http";
import { listInstalled, setRegistryUrl } from "@/lib/mcp/marketplace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const [catalog, installed] = await Promise.all([currentCatalog(refresh), listInstalled()]);
  return Response.json({
    entries: catalog.entries,
    categories: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABEL[id] })),
    installed,
    registry: catalog.registry,
  });
}

export async function PUT(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const url = body.registryUrl;
  if (url !== null && typeof url !== "string") return bad("registryUrl must be a string");
  return handle(async () => {
    await setRegistryUrl(url);
    const catalog = await currentCatalog(true);
    return Response.json({ ok: true, registry: catalog.registry, entries: catalog.entries });
  });
}
