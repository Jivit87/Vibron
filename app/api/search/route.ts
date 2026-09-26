/**
 * GET /api/search?repoKey&q&regex=1&case=1&glob=a,b
 *   → { matches: {path,line,col,text}[], truncated }
 *
 * ripgrep over the workspace folder when available; otherwise (or for a
 * store-backed workspace) a JS scan of the workspace files.
 */

import { ripgrep, searchFiles, SearchInputError, type SearchOptions } from "@/lib/search";
import { listFiles, openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoKey = params.get("repoKey") ?? "";
  const query = params.get("q") ?? "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  if (!query) return Response.json({ matches: [], truncated: false });
  if (query.length > 1000) return Response.json({ error: "Query too long" }, { status: 400 });

  const options: SearchOptions = {
    query,
    regex: params.get("regex") === "1" || params.get("regex") === "true",
    caseSensitive: params.get("case") === "1" || params.get("case") === "true",
    globs: (params.get("glob") ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
      .slice(0, 50),
  };

  try {
    const handle = await openWorkspace(repoKey);
    if (handle.rootPath) {
      const result = await ripgrep(handle.rootPath, options);
      if (result) return Response.json(result);
    }
    return Response.json(searchFiles(await listFiles(handle), options));
  } catch (error) {
    if (error instanceof SearchInputError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}
