/**
 * POST /api/recipes/run — run a recipe, streaming its progress as SSE.
 *
 * Body: `{ repoKey, name, params?, model?, commandPolicy?, editPolicy?, autoCheckpoint? }`.
 *
 * The stream is the ordinary run stream (`OrchestrationEvent`s: the recipe
 * as a plan, one lane per step, verification and command events, and a
 * final `run_done`), so the composer's run view renders it unchanged. The
 * run is registered like an agent run: its id travels in `X-Run-Id`, and
 * approvals and Stop use `/api/agent/approve` and `/api/agent/cancel`.
 */

import type { EventSink, OrchestrationEvent } from "@/lib/agents/events";
import { resolveModel } from "@/lib/ai";
import { createCheckpoint } from "@/lib/checkpoints";
import { jsonBody, str } from "@/lib/deliver/errors";
import { RUN_ID_HEADER } from "@/lib/harness/contracts";
import { cancelRun, createRun, finishRun, requestApproval } from "@/lib/harness/runs";
import { describeInvocation, recipeSolver } from "@/lib/recipes/run";
import { RECIPE_NAME_RE, resolveParams } from "@/lib/recipes/schema";
import { findRecipe } from "@/lib/recipes/store";
import { encodeSse, sseHeaders } from "@/lib/sse";
import { getGraph } from "@/lib/store";
import { detectVerifyCommands } from "@/lib/verify";
import { fullReindex, openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
/** A recipe can chain several agent steps; each may take minutes. */
export const maxDuration = 800;

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  const repoKey = str(body.repoKey);
  const name = str(body.name);
  if (!repoKey || !name) return Response.json({ error: "repoKey and name are required" }, { status: 400 });
  if (!RECIPE_NAME_RE.test(name)) return Response.json({ error: "name must be a recipe name" }, { status: 400 });
  if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params))) {
    return Response.json({ error: "params must be an object" }, { status: 400 });
  }

  const handle = await openWorkspace(repoKey);
  const entry = await findRecipe(name, handle.rootPath);
  if (!entry || entry.source === "file") return Response.json({ error: `No recipe named "${name}".` }, { status: 404 });
  if (!entry.recipe) {
    return Response.json({ error: `Recipe "${name}" is invalid.`, errors: entry.errors ?? [] }, { status: 422 });
  }
  const recipe = entry.recipe;
  const { values, issues } = resolveParams(recipe, (body.params as Record<string, unknown> | undefined) ?? {});
  if (issues.length) {
    return Response.json({ error: "Invalid recipe parameters.", errors: issues }, { status: 400 });
  }

  const commandPolicy = body.commandPolicy === "auto" || body.commandPolicy === "never" ? body.commandPolicy : "ask";
  const editPolicy = body.editPolicy === "ask" ? "ask" : "auto";
  const requestedModel = str(body.model) || "auto";

  if (!(await getGraph(repoKey))) await fullReindex(handle);
  const checkpoint =
    body.autoCheckpoint !== false
      ? await createCheckpoint(handle, `Recipe ${recipe.name}`).catch(() => null)
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

      if (checkpoint) {
        send({ type: "checkpoint", id: checkpoint.id, label: checkpoint.label, fileCount: checkpoint.fileCount });
      }

      try {
        const model = await resolveModel(requestedModel, { agenticOnly: true });
        const commands = handle.rootPath ? await detectVerifyCommands(handle.rootPath).catch(() => []) : [];
        const solve = recipeSolver(recipe, values, {
          commandPolicy,
          editPolicy,
          requestApproval: (agentId, ask) => requestApproval(runId, agentId, ask),
        });
        await solve({
          handle,
          task: describeInvocation(recipe, values),
          model,
          emit: send,
          signal: run.signal,
          runId,
          budget: { maxTurns: 40 },
          verify: { enabled: true, commands, timeoutMs: 600_000, baseline: false },
          useRepoRules: true,
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
