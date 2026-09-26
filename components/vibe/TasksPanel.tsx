"use client";

/**
 * The task queue: fix and review tasks queued from the UI, the CLI, the
 * local API or an issue. One running task per repo, FIFO. Selecting a
 * running task attaches its live event stream to the normal run view.
 */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { attachedTask, attachTaskRun } from "@/lib/client/agent-stream";
import { cancelTask, listTasks, shortRef, type TaskRow, type TaskState } from "@/lib/client/deliver";
import { useViberon } from "@/store/viberon";
import { cx, EmptyState, formatAgo, IconButton } from "@/components/vibe/primitives";

const STATE: Record<TaskState, { label: string; color: string }> = {
  running: { label: "running", color: "var(--vb-accent)" },
  queued: { label: "queued", color: "var(--vb-text-mid)" },
  done: { label: "done", color: "var(--vb-mint)" },
  failed: { label: "failed", color: "var(--vb-rose)" },
  cancelled: { label: "cancelled", color: "var(--vb-text-faint)" },
};

const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;

export function TasksPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const streaming = useViberon((s) => s.streaming);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!repoKey) return;
    setLoading(true);
    const result = await listTasks(repoKey);
    setLoading(false);
    if (result.ok) {
      setTasks(result.tasks ?? null);
      setError(null);
      setMissing(false);
    } else {
      setError(result.error ?? null);
      setMissing(Boolean(result.missing));
    }
  }, [repoKey]);

  const active = tasks?.some((t) => t.state === "running" || t.state === "queued") ?? false;

  useEffect(() => {
    void refresh();
    if (missing) return;
    const id = window.setInterval(() => void refresh(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    return () => window.clearInterval(id);
  }, [refresh, active, missing]);

  async function cancel(task: TaskRow) {
    setCancelling(task.id);
    const result = await cancelTask(task.id);
    setCancelling(null);
    if (!result.ok) toast.error(result.error ?? "Could not cancel the task.");
    void refresh();
  }

  function attach(task: TaskRow) {
    if (streaming) {
      toast.error("A run is already showing. Stop it first.");
      return;
    }
    useViberon.getState().setAgentDockOpen(true);
    void attachTaskRun(task);
  }

  const attached = streaming ? attachedTask() : null;
  const counts = (tasks ?? []).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.state]: (acc[t.state] ?? 0) + 1 }), {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[26px] shrink-0 items-center gap-3 border-b px-3 font-mono text-[11px]" style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-dim)" }}>
        {(["running", "queued", "failed", "done"] as const).map((s) => (
          <span key={s}>
            <span style={{ color: counts[s] ? STATE[s].color : "var(--vb-text-faint)" }}>{counts[s] ?? 0}</span> {s}
          </span>
        ))}
        <div className="flex-1" />
        <IconButton title="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !tasks ? (
          <EmptyState title={missing ? "The task queue is not available" : "Could not load tasks"} body={missing ? "This server does not expose /api/tasks yet." : error} />
        ) : !tasks ? (
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <div className="vb-shimmer h-3 w-2/3 rounded-[3px]" />
            <div className="vb-shimmer h-3 w-1/2 rounded-[3px]" />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState title="No tasks" body="Fix CI from a pull request, `viberon fix --queue`, or POST /api/tasks adds one here." />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]" aria-label="Tasks">
            <thead>
              <tr className="text-left text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                <th className="w-[92px] py-0.5 pl-3 font-normal">state</th>
                <th className="py-0.5 font-normal">task</th>
                <th className="w-[52px] py-0.5 font-normal">kind</th>
                <th className="w-[52px] py-0.5 font-normal">source</th>
                <th className="w-[72px] py-0.5 font-normal">age</th>
                <th className="w-[128px] py-0.5 font-normal">pull request</th>
                <th className="w-[32px] py-0.5" />
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const st = STATE[task.state];
                const first = task.task.split("\n").find((l) => l.trim()) ?? task.id;
                const live = task.state === "running";
                const isAttached = attached === task.id;
                return (
                  <tr
                    key={task.id}
                    className={cx("group h-[24px] border-t align-middle", live && "cursor-pointer hover:bg-[var(--vb-hover)]")}
                    style={{ borderColor: "var(--vb-line-faint)", background: isAttached ? "var(--vb-accent-soft)" : undefined }}
                    onClick={() => live && !isAttached && attach(task)}
                    title={[task.task, task.error ? `Error: ${task.error}` : "", live ? "Click to watch the live run" : ""].filter(Boolean).join("\n\n")}
                  >
                    <td className="pl-3">
                      <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: st.color }}>
                        {live ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <span className="size-[6px] rounded-full" style={{ background: st.color }} />
                        )}
                        {isAttached ? "watching" : st.label}
                      </span>
                    </td>
                    <td className="truncate pr-2" style={{ color: task.state === "cancelled" ? "var(--vb-text-dim)" : "var(--vb-text)" }}>
                      {first}
                      {task.error && (
                        <span className="ml-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
                          {task.error}
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
                      {task.kind}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
                      {task.source}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {task.createdAt ? formatAgo(task.createdAt) : ""}
                    </td>
                    <td className="truncate pr-2">
                      {task.prUrl && (
                        <a
                          href={task.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex max-w-full items-center gap-1 font-mono text-[11px] hover:underline"
                          style={{ color: "var(--vb-text-mid)" }}
                        >
                          <span className="truncate">{shortRef(task.prUrl)}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {(task.state === "queued" || task.state === "running") && (
                        <span className="hidden group-hover:inline-flex">
                          <IconButton title="Cancel task" tone="danger" disabled={cancelling === task.id} onClick={() => void cancel(task)}>
                            <X className="size-3.5" />
                          </IconButton>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
