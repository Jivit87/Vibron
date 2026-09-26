/**
 * GET /api/tasks/:id/events → SSE, the same `data: <OrchestrationEvent>`
 * frames as POST /api/agent. Replays the task's buffered events, then
 * streams the live tail, and closes when the task finishes (at once for a
 * finished task). 404 for an unknown task. Closing the stream does not
 * cancel the task (DELETE /api/tasks/:id does).
 */

import { getTaskQueue } from "@/lib/tasks";
import { encodeSse, sseHeaders } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const queue = getTaskQueue();
  if (!(await queue.get(id))) return Response.json({ error: "Unknown task" }, { status: 404 });

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
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
      unsubscribe = await queue.subscribe(
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
      if (closed) unsubscribe?.();
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe?.();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
