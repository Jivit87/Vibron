/**
 * File operations for the explorer: create, delete, rename, mkdir.
 *
 * Reads and single-file writes stay on the existing
 * `/api/repos/files/[repoKey]` route; this one covers the structural
 * operations the file tree's context menu needs.
 *
 *   POST   /api/files  { repoKey, op: "create"|"mkdir"|"rename"|"delete", … }
 */

import {
  createDirectory,
  deleteFile,
  fileExists,
  openWorkspace,
  renameFile,
  writeFile,
  WorkspacePathError,
} from "@/lib/workspace";

export const runtime = "nodejs";

interface Body {
  repoKey?: unknown;
  op?: unknown;
  path?: unknown;
  to?: unknown;
  content?: unknown;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const op = typeof body.op === "string" ? body.op : "";
  const path = typeof body.path === "string" ? body.path.trim() : "";

  if (!repoKey || !op || !path) {
    return Response.json(
      { error: "repoKey, op and path are required" },
      { status: 400 },
    );
  }

  const handle = await openWorkspace(repoKey);

  try {
    switch (op) {
      case "create": {
        if (await fileExists(handle, path)) {
          return Response.json(
            { error: `${path} already exists.` },
            { status: 409 },
          );
        }
        const content = typeof body.content === "string" ? body.content : "";
        await writeFile(handle, path, content);
        return Response.json({ ok: true, path });
      }

      case "mkdir": {
        await createDirectory(handle, path);
        return Response.json({ ok: true, path });
      }

      case "rename": {
        const to = typeof body.to === "string" ? body.to.trim() : "";
        if (!to) {
          return Response.json({ error: "`to` is required" }, { status: 400 });
        }
        if (await fileExists(handle, to)) {
          return Response.json({ error: `${to} already exists.` }, { status: 409 });
        }
        const ok = await renameFile(handle, path, to);
        if (!ok) {
          return Response.json({ error: `${path} not found.` }, { status: 404 });
        }
        return Response.json({ ok: true, path: to });
      }

      case "delete": {
        const ok = await deleteFile(handle, path);
        if (!ok) {
          return Response.json({ error: `${path} not found.` }, { status: 404 });
        }
        return Response.json({ ok: true });
      }

      default:
        return Response.json({ error: `Unknown op: ${op}` }, { status: 400 });
    }
  } catch (error) {
    const status = error instanceof WorkspacePathError ? 400 : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
