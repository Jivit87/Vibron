/**
 * POST /api/agent — the main agent endpoint.
 *
 * Streams the whole orchestration as SSE: plan, per-agent output, file
 * diffs, terminal output, token ledger, and the final summary.
 *
 * The run is registered before the stream opens, so its id can travel in
 * the `X-Run-Id` header as well as `run_start`. Approvals and Stop arrive
 * on other requests (`/api/agent/approve`, `/api/agent/cancel`) and find the
 * run through that id.
 *
 * With a `sessionId` the run belongs to a session (docs/MULTI_SESSION.md):
 * it waits for a slot under the workspace's concurrency limit, feeds the
 * session's status, ledger and replay buffer, locks the files it writes
 * against other sessions, gets a session-scoped checkpoint (undo reverts
 * only this session's files), and runs in the session's worktree when the
 * session is isolated.
 */

import { orchestrate } from "@/lib/agents/orchestrator";
import type { EventSink, OrchestrationEvent, RunPlan, RunStatus } from "@/lib/agents/events";
import { encodeSse, sseHeaders } from "@/lib/sse";
import { fullReindex, openWorkspace } from "@/lib/workspace";
import { getGraph } from "@/lib/store";
import { createCheckpoint, createSessionCheckpoint, journalFileChange } from "@/lib/checkpoints";
import { sanitizeAttachments, sanitizeImages } from "@/lib/composer/types";
import { resolveAttachments } from "@/lib/harness/attachments";
import { RUN_ID_HEADER, type Interaction } from "@/lib/harness/contracts";
import { cancelRun, createRun, finishRun, requestApproval } from "@/lib/harness/runs";
import { solveTask } from "@/lib/harness/solve";
import { resolveModel } from "@/lib/ai";
import { detectVerifyCommands } from "@/lib/verify";
import { recordFixNote } from "@/lib/memory/graph";
import { loadHookEngine } from "@/lib/hooks/engine";
import { getSessionManager, SessionError, type SessionSummary } from "@/lib/sessions";

export const runtime = "nodejs";
/** Long-horizon runs: a full-stack build can legitimately take minutes. */
export const maxDuration = 800;

type Body = Record<string, unknown>;

function parseHistory(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        Boolean(m) &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string",
    )
    .slice(-16);
}

/** Shape-check an approved plan; `renormalizePlan` does the deep cleanup. */
function parsePlan(raw: unknown): RunPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const plan = raw as Partial<RunPlan>;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return undefined;
  return {
    summary: typeof plan.summary === "string" ? plan.summary : "",
    steps: plan.steps.slice(0, 40).filter((s) => s && typeof s === "object"),
    waves: [],
  };
}

function clampInt(raw: unknown, min: number, max: number): number | undefined {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!repoKey || !prompt) {
    return Response.json(
      { error: "repoKey and prompt are required" },
      { status: 400 },
    );
  }

  const interaction: Interaction =
    body.interaction === "plan" || body.interaction === "ask" || body.interaction === "fix"
      ? body.interaction
      : "agent";
  const plan = interaction === "agent" ? parsePlan(body.plan) : undefined;
  const mode =
    body.mode === "single" || body.mode === "orchestrated" ? body.mode : "auto";
  const model = typeof body.model === "string" ? body.model : "auto";
  const commandPolicy =
    body.commandPolicy === "auto" || body.commandPolicy === "never"
      ? body.commandPolicy
      : "ask";
  const editPolicy = body.editPolicy === "ask" ? "ask" : "auto";
  const concurrency = Math.max(1, Math.min(6, Number(body.concurrency) || 3));
  const showThinking = body.showThinking !== false;
  const autoCheckpoint = body.autoCheckpoint !== false;
  const retrieval = {
    depth: clampInt(body.retrievalDepth, 1, 4),
    maxNodes: clampInt(body.maxNodes, 5, 60),
  };
  const attachments = sanitizeAttachments(body.attachments);
  const images = sanitizeImages(body.images);

  // A session run: the session must exist, belong to this workspace, and be
  // free. An isolated session works in its own worktree.
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const sessions = sessionId ? await getSessionManager() : null;
  let session: SessionSummary | undefined;
  if (sessions) {
    session = sessions.get(sessionId);
    if (!session || session.repoKey !== repoKey) {
      return Response.json({ error: "Unknown session" }, { status: 404 });
    }
  }
  const worktree = session ? sessions!.worktreeOf(session.id) : undefined;

  const handle = await openWorkspace(worktree?.repoKey ?? repoKey);
  if (interaction === "fix" && !handle.rootPath) {
    return Response.json(
      { error: "Fix mode needs a workspace on disk. Open a local folder or clone the repository first." },
      { status: 400 },
    );
  }

  // First run against a workspace needs a graph before the engine is useful.
  if (!(await getGraph(handle.repoKey))) {
    await fullReindex(handle);
  }

  // Events are forwarded to whatever stream is attached; until it is, and
  // after it closes, they are dropped. A session also sees every event.
  let sink: EventSink = () => {};
  let journalId: string | null = null;
  let journal: Promise<void> = Promise.resolve();
  let lastStatus: RunStatus | null = null;
  let fatalError: string | undefined;
  const deliver: EventSink = (event) => {
    if (event.type === "run_done") lastStatus = event.status ?? "done";
    if (event.type === "error" && event.fatal) fatalError = event.message;
    if (session) {
      sessions!.observe(session.id, event);
      if (event.type === "file_change" && journalId) {
        const id = journalId;
        journal = journal.then(() => journalFileChange(id, event)).catch(() => undefined);
      }
    }
    sink(event);
  };
  const run = createRun(repoKey, deliver, session ? { sessionId: session.id, label: session.title } : {});
  const { runId } = run;

  if (session) {
    try {
      session = sessions!.beginRun(session.id, runId, { model });
    } catch (error) {
      finishRun(runId);
      const status = error instanceof SessionError ? error.status : 500;
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
    }
  }

  // Snapshot before we touch anything, so a run that goes wrong is one
  // click to undo rather than twenty individual reverts. Plan and ask runs
  // change nothing, so they get no checkpoint. A session's checkpoint is a
  // journal of its own writes, so undoing it leaves other sessions alone.
  const label = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
  const checkpoint =
    autoCheckpoint && interaction === "agent"
      ? await (session
          ? createSessionCheckpoint(handle, session.id, label)
          : createCheckpoint(handle, label)
        ).catch(() => null)
      : null;
  if (checkpoint && session) {
    journalId = checkpoint.id;
    sessions!.addCheckpoint(session.id, checkpoint.id);
  }

  // A closed tab is a Stop: nobody is left to answer approvals or read output.
  request.signal.addEventListener("abort", () => cancelRun(runId));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      sink = (event: OrchestrationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          closed = true;
        }
      };
      const send = deliver;

      // Heartbeat: a long planning turn can exceed proxy idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      if (checkpoint) {
        send({
          type: "checkpoint",
          id: checkpoint.id,
          label: checkpoint.label,
          fileCount: checkpoint.fileCount,
        });
      }

      try {
        // Wait for a run slot under the workspace's concurrency limit. Fix
        // mode snapshots and restores the whole tree, so in a shared
        // checkout it runs alone.
        if (session) {
          const granted = await sessions!.acquireSlot(session.id, {
            exclusive: interaction === "fix",
            signal: run.signal,
            emit: send,
          });
          if (!granted) {
            send({
              type: "run_done",
              status: "cancelled",
              summary: "Stopped before it started: the run was still queued.",
              filesChanged: 0,
              durationMs: Date.now() - run.startedAt,
              costUsd: 0,
            });
            return;
          }
        }
        // An isolated session's hooks are trusted as the workspace's, not
        // as a fresh temporary checkout's.
        const hooks =
          worktree && handle.rootPath
            ? await loadHookEngine({
                root: handle.rootPath,
                trustRoot: worktree.repoRoot,
                repoKey,
                runId,
                emit: send,
                signal: run.signal,
              }).catch(() => null)
            : undefined;
        if (interaction === "fix") {
          // Autonomous fix: localize → fix → gate (original vs patched) → evidence.
          // The git snapshot is the checkpoint; solveTask streams its own run_start/run_done.
          const resolved = await resolveModel(model, { agenticOnly: true });
          const commands = await detectVerifyCommands(handle.rootPath!).catch(() => []);
          const result = await solveTask({
            handle,
            task: prompt,
            model: resolved,
            emit: send,
            signal: run.signal,
            runId,
            ...(hooks !== undefined ? { hooks } : {}),
            budget: { maxTurns: 40 },
            verify: { enabled: true, commands, timeoutMs: 300_000, baseline: true },
            useRepoRules: true,
            review: true,
            // Run memory: the next task on the same area sees what was fixed and why.
            onSolved: (solved) => {
              if (!solved.filesChanged.length) return;
              recordFixNote(handle.rootPath!, {
                issue: prompt,
                files: solved.filesChanged,
                rootCause: solved.summary,
                verified: solved.status === "resolved",
              });
            },
          });
          if (result.error && result.status === "error") {
            send({ type: "error", message: result.error, fatal: true });
          }
          return;
        }
        await orchestrate({
          repoKey,
          handle,
          request: prompt,
          history: parseHistory(body.history),
          mode,
          model,
          commandPolicy,
          editPolicy,
          concurrency,
          interaction,
          plan,
          showThinking,
          retrieval,
          attachments: await resolveAttachments(handle, attachments),
          images,
          emit: send,
          signal: run.signal,
          runId,
          requestApproval: (agentId, ask) => requestApproval(runId, agentId, ask),
          ...(hooks !== undefined ? { hooks } : {}),
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          fatal: true,
        });
        send({
          type: "run_done",
          status: run.signal.aborted ? "cancelled" : "failed",
          summary: error instanceof Error ? error.message : String(error),
          filesChanged: 0,
          durationMs: Date.now() - run.startedAt,
          costUsd: 0,
        });
      } finally {
        clearInterval(heartbeat);
        await journal;
        if (session) {
          sessions!.finishRun(
            session.id,
            lastStatus ?? (run.signal.aborted ? "cancelled" : "failed"),
            lastStatus === "failed" || !lastStatus ? fatalError : undefined,
          );
        }
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

  return new Response(stream, {
    headers: { ...sseHeaders(), [RUN_ID_HEADER]: runId },
  });
}
