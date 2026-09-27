/**
 * POST /api/plans/:id/rerun — run a stored plan version again.
 *
 * Body: `{ repoKey, model?, commandPolicy?, editPolicy?, concurrency?, autoCheckpoint? }`.
 * Streams the orchestration as SSE, exactly like POST /api/agent with an
 * approved plan: the run registers (X-Run-Id; approvals and Stop go through
 * /api/agent/approve and /api/agent/cancel), a checkpoint is taken first,
 * and the outcome is appended to the version's run log.
 */

import type { EventSink, OrchestrationEvent } from "@/lib/agents/events";
import { orchestrate } from "@/lib/agents/orchestrator";
import { createCheckpoint } from "@/lib/checkpoints";
import { clampInt, diskWorkspace, errorResponse, readJson } from "@/lib/experiments/http";
import { RUN_ID_HEADER } from "@/lib/harness/contracts";
import { cancelRun, createRun, finishRun, requestApproval } from "@/lib/harness/runs";
import { rerunInput } from "@/lib/plans";
import { PlanStore } from "@/lib/plans/store";
import { encodeSse, sseHeaders } from "@/lib/sse";
import { getGraph } from "@/lib/store";
import { fullReindex } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: Record<string, unknown>;
  let prepared: Awaited<ReturnType<typeof rerunInput>>;
  let workspace: Awaited<ReturnType<typeof diskWorkspace>>;
  let store: PlanStore;
  try {
    body = await readJson(request);
    workspace = await diskWorkspace(body.repoKey);
    store = new PlanStore(workspace.root);
    prepared = await rerunInput(store, id, { model: typeof body.model === "string" ? body.model : undefined });
  } catch (error) {
    return errorResponse(error);
  }
  const { handle } = workspace;
  const repoKey = handle.repoKey;
  const commandPolicy = body.commandPolicy === "auto" || body.commandPolicy === "never" ? body.commandPolicy : "ask";
  const editPolicy = body.editPolicy === "ask" ? "ask" : "auto";
  const concurrency = clampInt(body.concurrency, 1, 6) ?? 3;

  if (!(await getGraph(repoKey))) await fullReindex(handle);
  const checkpoint =
    body.autoCheckpoint !== false
      ? await createCheckpoint(handle, `Re-run plan ${id.slice(-6)}`).catch(() => null)
      : null;

  let sink: EventSink = () => {};
  const run = createRun(repoKey, (event) => sink(event));
  const { runId } = run;
  request.signal.addEventListener("abort", () => cancelRun(runId));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: OrchestrationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          closed = true;
        }
      };
      sink = send;
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);
      if (checkpoint) send({ type: "checkpoint", id: checkpoint.id, label: checkpoint.label, fileCount: checkpoint.fileCount });

      try {
        await orchestrate({
          ...prepared,
          repoKey,
          handle,
          history: [],
          commandPolicy,
          editPolicy,
          concurrency,
          planStore: store,
          emit: send,
          signal: run.signal,
          runId,
          requestApproval: (agentId, ask) => requestApproval(runId, agentId, ask),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "error", message, fatal: true });
        send({
          type: "run_done",
          status: run.signal.aborted ? "cancelled" : "failed",
          summary: message,
          filesChanged: 0,
          durationMs: Date.now() - run.startedAt,
          costUsd: 0,
        });
      } finally {
        clearInterval(heartbeat);
        finishRun(runId);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
    cancel() {
      cancelRun(runId);
    },
  });

  return new Response(stream, { headers: { ...sseHeaders(), [RUN_ID_HEADER]: runId } });
}
