/**
 * GET /api/workspace/events?repoKey= (SSE)
 *   → { type: "fs", changed: string[], deleted: string[] } per batch
 *
 * Store-backed workspaces have no folder to watch; the stream stays open
 * (with keep-alives) but never emits fs events.
 */

import { encodeSse, sseHeaders } from "@/lib/sse";
import { openWorkspace } from "@/lib/workspace";
import { watchWorkspace } from "@/lib/workspace/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const KEEPALIVE_MS = 25_000;
const encoder = new TextEncoder();

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const handle = await openWorkspace(repoKey);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup();
        }
      };
      const unsubscribe = handle.rootPath
        ? watchWorkspace(handle.rootPath, (event) => send(encodeSse(event)))
        : () => {};
      const keepAlive = setInterval(() => send(encoder.encode(": keep-alive\n\n")), KEEPALIVE_MS);
      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      send(encoder.encode(": connected\n\n"));
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
