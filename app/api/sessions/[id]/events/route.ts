/**
 * GET /api/sessions/:id/events → SSE, the same `data: <OrchestrationEvent>`
 * frames as POST /api/agent. Replays the session's current (or last) run
 * from its buffer, then streams the live tail, and closes when the run
 * finishes (at once when nothing is running). A client that reloaded, or
 * reattaches to a background session, uses it to catch up without losing
 * events. Closing it does not cancel the run.
 */

import { getSessionManager } from "@/lib/sessions";
import { encodeSse, sseHeaders } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const manager = await getSessionManager();
  if (!manager.get(id)) return Response.json({ error: "Unknown session" }, { status: 404 });
  manager.touch(id);

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 15_000);
      unsubscribe = manager.subscribe(
        id,
        (event) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSse(event));
          } catch {
            close();
          }
        },
        close,
      );
      if (closed) unsubscribe();
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe?.();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
