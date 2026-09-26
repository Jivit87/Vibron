"use client";

/**
 * Integrated terminal.
 *
 * Real process execution against the workspace root, streamed over SSE.
 * Shares its session registry with the agent's `run_command` tool, so a
 * command the agent ran shows up here as a tab you can inspect and re-run.
 *
 * This is not a pty — no curses apps, no interactive prompts. It runs
 * commands and streams their output, which covers installs, builds, tests,
 * dev servers, and git.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Plus,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { useViberon, type TerminalSessionView } from "@/store/viberon";
import { cx, Dot, EmptyState, IconButton } from "@/components/vibe/primitives";

import { applyTerminalEvent, stripAnsi, type TerminalStreamEvent } from "@/lib/client/terminal-stream";

export function TerminalPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const rootPath = useViberon((s) => s.rootPath);
  const terminals = useViberon((s) => s.terminals);
  const selectedId = useViberon((s) => s.activeTerminalId);
  const setActive = useViberon((s) => s.setActiveTerminal);

  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const active = terminals.find((t) => t.id === selectedId) ?? terminals[0] ?? null;

  // Pull existing sessions on mount — the agent may have started some.
  useEffect(() => {
    if (!repoKey) return;
    void fetch(`/api/terminal?repoKey=${encodeURIComponent(repoKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { sessions?: TerminalSessionView[] } | null) => {
        if (body?.sessions?.length) {
          useViberon.getState().setTerminals(body.sessions);
        }
      })
      .catch(() => {});
  }, [repoKey]);

  // Stream the active session while it is running. Keyed on id + status,
  // not the session object, so appending output does not reconnect; on a
  // reconnect (panel remount, network blip) `since=` resumes from the last
  // offset instead of replaying the whole history.
  const activeId = active?.id;
  const activeStatus = active?.status;
  useEffect(() => {
    if (!activeId || activeStatus !== "running") return;
    const controller = new AbortController();

    void (async () => {
      try {
        const current = useViberon.getState().terminals.find((t) => t.id === activeId);
        const since = current?.offset;
        const response = await fetch(
          `/api/terminal?sessionId=${encodeURIComponent(activeId)}&stream=1${since !== undefined ? `&since=${since}` : ""}`,
          { signal: controller.signal },
        );
        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const payload = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!payload) continue;
            let event: TerminalStreamEvent;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }
            const store = useViberon.getState();
            const session = store.terminals.find((t) => t.id === activeId);
            if (!session) return;
            store.upsertTerminal(applyTerminalEvent(session, event, since !== undefined));
            if (event.type === "end" && event.detectedUrl) store.setPreviewUrl(event.detectedUrl);
          }
        }
      } catch {
        // Aborted on unmount or session switch.
      }
    })();

    return () => controller.abort();
  }, [activeId, activeStatus]);

  // Stick to the bottom as output arrives.
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 140) el.scrollTop = el.scrollHeight;
  }, [active?.output]);

  const run = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || !repoKey) return;

      setHistory((prev) => [trimmed, ...prev.filter((c) => c !== trimmed)].slice(0, 50));
      setHistoryIndex(-1);
      setCommand("");

      const response = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, command: trimmed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? "Could not start that command.");
        return;
      }
      const session = (await response.json()) as TerminalSessionView;
      useViberon.getState().upsertTerminal(session);
    },
    [repoKey],
  );

  async function kill(id: string) {
    await fetch(`/api/terminal?sessionId=${id}`, { method: "DELETE" });
  }

  if (!rootPath) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState
          icon={<TerminalSquare className="size-4" />}
          title="No folder on disk"
          body="This workspace lives in memory. Open a local folder to run commands, install dependencies, and start a dev server."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex h-[28px] shrink-0 items-center gap-1 border-b px-1.5"
        style={{ borderColor: "var(--vb-line)" }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {terminals.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => setActive(session.id)}
              className={cx(
                "inline-flex h-[22px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-[3px] px-1.5 font-mono text-[11.5px]",
                session.id === active?.id ? "bg-[var(--vb-active)]" : "hover:bg-[var(--vb-hover)]",
              )}
              style={{ color: session.id === active?.id ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
              title={`${session.origin === "agent" ? "Started by agent: " : ""}${session.command}`}
            >
              <Dot
                color={
                  session.status === "running"
                    ? "var(--vb-mint)"
                    : session.exitCode === 0
                      ? "var(--vb-text-faint)"
                      : "var(--vb-rose)"
                }
                live={session.status === "running"}
                size={5}
              />
              {session.origin === "agent" && (
                <span style={{ color: "var(--vb-text-faint)" }}>agent</span>
              )}
              <span className="truncate">{session.command}</span>
            </button>
          ))}
        </div>
        {active?.detectedUrl && (
          <IconButton
            title={`Open preview at ${active.detectedUrl}`}
            onClick={() => {
              useViberon.getState().setPreviewUrl(active.detectedUrl);
              useViberon.getState().setPreviewOpen(true);
            }}
          >
            <ExternalLink className="size-3.5" />
          </IconButton>
        )}
        {active?.status === "running" && (
          <IconButton title="Stop" tone="danger" onClick={() => void kill(active.id)}>
            <Square className="size-3 fill-current" />
          </IconButton>
        )}
        <IconButton title="New command" onClick={() => inputRef.current?.focus()}>
          <Plus className="size-3.5" />
        </IconButton>
        {terminals.length > 0 && (
          <IconButton
            title="Clear finished sessions"
            onClick={() =>
              useViberon.getState().setTerminals(terminals.filter((t) => t.status === "running"))
            }
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        )}
      </div>

      <div
        ref={outputRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        style={{ background: "var(--vb-bg-void)" }}
        onClick={() => inputRef.current?.focus()}
      >
        {active ? (
          <pre className="vb-term" style={{ color: "var(--vb-text)" }}>
            {stripAnsi(active.output)}
          </pre>
        ) : (
          <p className="vb-term" style={{ color: "var(--vb-text-faint)" }}>
            {rootPath}
            {"\n"}Type a command below. Try `npm install`, `npm run dev`, or `git status`.
          </p>
        )}
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 border-t px-3 py-1.5"
        style={{ borderColor: "var(--vb-line-faint)", background: "var(--vb-bg-void)" }}
      >
        <ChevronRight className="size-3 shrink-0" style={{ color: "var(--vb-mint)" }} />
        <input
          ref={inputRef}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void run(command);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              const next = Math.min(historyIndex + 1, history.length - 1);
              if (next >= 0 && history[next]) {
                setHistoryIndex(next);
                setCommand(history[next]);
              }
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              const next = historyIndex - 1;
              setHistoryIndex(next);
              setCommand(next >= 0 ? (history[next] ?? "") : "");
            }
          }}
          placeholder="Run a command…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Terminal command"
          className="vb-term min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--vb-text-faint)]"
          style={{ color: "var(--vb-text-hi)" }}
        />
      </div>
    </div>
  );
}
