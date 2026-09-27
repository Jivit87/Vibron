/**
 * GET /api/experiments/:id/events?repoKey=… → SSE of `ExperimentEvent`s.
 *
 * Replays what happened so far, then streams the live tail, and closes when
 * the experiment finishes. For an experiment that is not running in this
 * process (finished, or from before a restart) it sends one
 * `experiment_done` frame with the stored record and closes. Closing the
 * stream does not stop the experiment (discard does).
 */

import { loadExperiment } from "@/lib/experiments";
import { diskWorkspace, errorResponse } from "@/lib/experiments/http";
import { subscribeExperiment } from "@/lib/experiments/live";
import { encodeSse, sseHeaders } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let record: Awaited<ReturnType<typeof loadExperiment>>;
  try {
    const { root } = await diskWorkspace(new URL(request.url).searchParams.get("repoKey"));
    record = await loadExperiment(root, id);
  } catch (error) {
    return errorResponse(error);
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let sawEvent = false;
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
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(data));
        } catch {
          close();
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
      unsubscribe = subscribeExperiment(
        id,
        (event) => {
          sawEvent = true;
          send(event);
        },
        () => {
          if (!sawEvent) send({ type: "experiment_done", experiment: record });
          close();
        },
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
