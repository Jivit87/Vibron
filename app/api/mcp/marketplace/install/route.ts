/**
 * Install (or reconfigure) a marketplace server.
 *
 *   POST /api/mcp/marketplace/install { id, values, dryRun: true }
 *        → the install plan: command, args, env, warnings, planHash. No side effects.
 *   POST /api/mcp/marketplace/install { id, values, confirm: true, planHash }
 *        → writes the config and stores secrets; refused if the plan changed.
 *
 * `values` may carry secret values on the way in. They go straight to the
 * credentials store; no response ever contains them.
 */

import { bad, findEntry, handle, readJson } from "@/lib/mcp/marketplace-http";
import { installServer, planInstall } from "@/lib/mcp/marketplace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const found = await findEntry(body.id);
  if (found instanceof Response) return found;
  const raw = body.values ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("values must be an object");
  const values = raw as Record<string, unknown>;

  return handle(async () => {
    if (body.dryRun === true) {
      return Response.json({ plan: await planInstall(found.entry, values, found.catalog.registry.url) });
    }
    const server = await installServer(found.entry, {
      values,
      confirm: body.confirm === true,
      planHash: typeof body.planHash === "string" ? body.planHash : undefined,
      registryUrl: found.catalog.registry.url,
    });
    return Response.json({ ok: true, server });
  });
}
