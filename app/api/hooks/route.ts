/**
 * Lifecycle hooks: what is configured, whether the workspace's hooks are
 * trusted, and what ran recently.
 *
 *   GET  /api/hooks?repoKey=…                          → overview + recent runs
 *   POST /api/hooks { action: "trust", repoKey, hash } → approve this exact file version
 *   POST /api/hooks { action: "revoke", repoKey }      → forget the approval
 *
 * Trust takes the hash the user was shown and refuses when the file on
 * disk no longer matches it, so approving never covers a version nobody
 * reviewed (the file can change between the GET and the click).
 */

import { describeHooks, recentHookRuns, type HooksOverview } from "@/lib/hooks/engine";
import { revokeWorkspaceHooks, trustWorkspaceHooks } from "@/lib/hooks/trust";
import type { CommandHook } from "@/lib/hooks/types";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

async function rootFor(repoKey: string): Promise<string | null> {
  if (!repoKey) return null;
  const handle = await openWorkspace(repoKey).catch(() => null);
  return handle?.rootPath ?? null;
}

const describeHook = (h: CommandHook) => ({
  id: h.id,
  event: h.event,
  matcher: h.matcher ?? null,
  command: h.command,
  timeoutSec: Math.round(h.timeoutMs / 1000),
});

function serialize(overview: HooksOverview) {
  const file = (f: HooksOverview["global"]) =>
    f ? { path: f.path, exists: f.exists, errors: f.errors, hooks: f.hooks.map(describeHook) } : null;
  return {
    global: file(overview.global),
    workspace: overview.workspace
      ? {
          ...file(overview.workspace),
          hash: overview.workspace.hash,
          trust: overview.workspace.trust,
          approvedAt: overview.workspace.approvedAt,
        }
      : null,
    builtins: overview.builtins,
    activeCount: overview.active.length,
  };
}

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  const root = await rootFor(repoKey);
  const overview = await describeHooks(root);
  return Response.json({ ...serialize(overview), rootPath: root, recent: repoKey ? recentHookRuns(repoKey) : [] });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const repoKey = typeof body?.repoKey === "string" ? body.repoKey : "";
  const root = await rootFor(repoKey);
  if (!root) return Response.json({ error: "This workspace has no folder on disk." }, { status: 400 });

  if (body.action === "revoke") {
    await revokeWorkspaceHooks(root);
  } else if (body.action === "trust") {
    const hash = typeof body.hash === "string" ? body.hash : "";
    const current = (await describeHooks(root)).workspace;
    if (!current?.exists || !current.hash) {
      return Response.json({ error: "This workspace has no .viberon/hooks.json to trust." }, { status: 404 });
    }
    if (current.errors.length && !current.hooks.length) {
      return Response.json({ error: `The hooks file is invalid: ${current.errors.join("; ")}` }, { status: 400 });
    }
    if (hash !== current.hash) {
      return Response.json(
        { error: "The hooks file changed since it was shown. Review it again before approving.", hash: current.hash },
        { status: 409 },
      );
    }
    try {
      await trustWorkspaceHooks(root, hash);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  } else {
    return Response.json({ error: 'action must be "trust" or "revoke"' }, { status: 400 });
  }
  const overview = await describeHooks(root);
  return Response.json({ ...serialize(overview), rootPath: root, recent: recentHookRuns(repoKey) });
}
