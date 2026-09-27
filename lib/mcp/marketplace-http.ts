/**
 * Shared plumbing for the `/api/mcp/marketplace/*` routes: body parsing,
 * catalog lookup, and mapping `MarketplaceError` to a JSON response.
 */

import { loadCatalog, type CatalogEntry, type LoadedCatalog } from "@/lib/mcp/catalog";
import { getRegistryUrl, MarketplaceError } from "@/lib/mcp/marketplace";

export const bad = (error: string, status = 400, code?: string) =>
  Response.json({ error, ...(code ? { code } : {}) }, { status });

export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Body must be a JSON object");
    return body as Record<string, unknown>;
  } catch {
    return bad("Body must be valid JSON");
  }
}

export async function currentCatalog(refresh = false): Promise<LoadedCatalog> {
  return loadCatalog(await getRegistryUrl(), { refresh });
}

export async function findEntry(id: unknown): Promise<{ entry: CatalogEntry; catalog: LoadedCatalog } | Response> {
  if (typeof id !== "string" || !id) return bad("id is required");
  const catalog = await currentCatalog();
  const entry = catalog.entries.find((e) => e.id === id);
  if (!entry) return bad(`No catalog entry "${id}"`, 404, "not-found");
  return { entry, catalog };
}

/** Run a handler, turning `MarketplaceError`s into their status code. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MarketplaceError) return bad(error.message, error.status, error.code);
    throw error;
  }
}
