import { registerLocalWorkspace, WorkspacePathError } from "@/lib/local-disk-workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const rootPath =
    typeof (body as { rootPath?: unknown }).rootPath === "string"
      ? (body as { rootPath: string }).rootPath
      : "";
  if (!rootPath) {
    return Response.json({ error: "rootPath is required" }, { status: 400 });
  }

  try {
    const meta = await registerLocalWorkspace(rootPath);
    return Response.json({ repoKey: meta.repoKey, label: meta.label });
  } catch (error) {
    const message = error instanceof WorkspacePathError ? error.message : "Could not open that folder.";
    return Response.json({ error: message }, { status: 400 });
  }
}
