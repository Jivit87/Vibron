"use client";

/**
 * Project memory panel.
 *
 * The agents' durable understanding of the project, made inspectable and
 * editable. This is what stops the tool from starting cold every session —
 * and because an agent can learn something wrong, the user needs to be able
 * to see it, correct it, and delete it.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  Check,
  ChevronRight,
  CornerUpLeft,
  Lightbulb,
  Network,
  ListTodo,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { MemoryEntry, MemoryTask } from "@/lib/memory/types";
import { loadFile } from "@/lib/file-loader";
import {
  backlinksFor,
  obsidianUrl,
  readMemoryIndex,
  type AnchoredEntry,
  type VaultInfo,
} from "@/lib/client/memory-graph";
import { useViberon } from "@/store/viberon";
import {
  cx,
  Dot,
  EmptyState,
  IconButton,
  PanelHeader,
} from "@/components/vibe/primitives";

const TASK_COLOR: Record<MemoryTask["status"], string> = {
  pending: "var(--vb-text-faint)",
  in_progress: "var(--vb-accent)",
  blocked: "var(--vb-amber)",
  done: "var(--vb-mint)",
  cancelled: "var(--vb-text-faint)",
};

export function MemoryPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const memory = useViberon((s) => s.memory);
  const setMemory = useViberon((s) => s.setMemory);
  const [loading, setLoading] = useState(false);
  const [editingOverview, setEditingOverview] = useState(false);
  const [draft, setDraft] = useState("");
  const [anchored, setAnchored] = useState<AnchoredEntry[]>([]);
  const [vault, setVault] = useState<VaultInfo | null>(null);
  const graph = useViberon((s) => s.graph);
  const rootPath = useViberon((s) => s.rootPath);
  const activeTabPath = useViberon((s) => s.activeTabPath);
  const selectedNodeId = useViberon((s) => s.selectedNodeId);

  const load = useCallback(async () => {
    if (!repoKey) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/memory?repoKey=${encodeURIComponent(repoKey)}`,
      );
      if (!response.ok) return;
      const body = (await response.json()) as { memory: never };
      setMemory(body.memory);
      const index = readMemoryIndex(body, { graph: useViberon.getState().graph ?? null, rootPath });
      setAnchored(index.entries);
      setVault(index.vault);
    } finally {
      setLoading(false);
    }
  }, [repoKey, rootPath, setMemory]);

  // Entries and the vault live only in this panel, so fetch on mount even
  // when the store already holds the memory blob.
  useEffect(() => {
    void load();
  }, [load]);

  async function patch(payload: Record<string, unknown>) {
    const response = await fetch("/api/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoKey, ...payload }),
    });
    if (!response.ok) {
      toast.error("Could not update memory.");
      return;
    }
    const body = (await response.json()) as { memory: never };
    setMemory(body.memory);
  }

  async function forget(entryId: string) {
    const response = await fetch(
      `/api/memory?repoKey=${encodeURIComponent(repoKey)}&entryId=${entryId}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      const body = (await response.json()) as { memory: never };
      setMemory(body.memory);
    }
  }

  if (!memory) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Memory" icon={<Brain className="size-3" />} />
        <EmptyState
          icon={<Brain className="size-4" />}
          title={loading ? "Loading memory…" : "No memory yet"}
          body="As agents work they record decisions, conventions, and facts here so the next session starts warm."
        />
      </div>
    );
  }

  const openTasks = memory.tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );
  const doneTasks = memory.tasks.filter((t) => t.status === "done");
  const openSuggestions = memory.suggestions.filter((s) => !s.resolved);
  const selectedFile = activeTabPath && !activeTabPath.startsWith("__") ? activeTabPath : null;
  const backlinks = backlinksFor(anchored, { file: selectedFile, symbolId: selectedNodeId }, graph ?? null);
  const selectedSymbol = selectedNodeId ? graph?.nodes.find((n) => n.id === selectedNodeId) : undefined;
  const selectionLabel = selectedSymbol?.name ?? selectedFile?.split("/").pop();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Memory"
        icon={<Brain className="size-3" />}
        actions={
          <IconButton title="Refresh" onClick={() => void load()}>
            <RefreshCw className={cx("size-3", loading && "animate-spin")} />
          </IconButton>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          {/* overview */}
          <div className="vb-box p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span
                className="text-[11px] font-semibold uppercase tracking-[0.04em]"
                style={{ color: "var(--vb-text-faint)" }}
              >
                What this project is
              </span>
              {!editingOverview && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(memory.overview);
                    setEditingOverview(true);
                  }}
                  className="text-[11px]"
                  style={{ color: "var(--vb-text-dim)" }}
                >
                  edit
                </button>
              )}
            </div>
            {editingOverview ? (
              <div className="flex flex-col gap-1.5">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  aria-label="Project overview"
                  className="w-full resize-none rounded-[4px] border bg-transparent px-2 py-1.5 text-[11.5px] leading-relaxed outline-none"
                  style={{
                    borderColor: "var(--vb-line)",
                    color: "var(--vb-text-hi)",
                  }}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void patch({ overview: draft });
                      setEditingOverview(false);
                    }}
                    className="h-6 rounded-[4px] px-2.5 text-[11px] font-semibold text-white"
                    style={{ background: "var(--vb-accent)" }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingOverview(false)}
                    className="h-6 rounded-[4px] px-2 text-[11px]"
                    style={{ color: "var(--vb-text-dim)" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p
                className="text-[11.5px] leading-relaxed"
                style={{ color: "var(--vb-text)" }}
              >
                {memory.overview || "Not described yet."}
              </p>
            )}
          </div>

          {vault && (
            <div className="-mt-2 flex items-center gap-2 px-0.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono" style={{ color: "var(--vb-text-faint)" }} title={vault.path}>
                vault · {vault.notes} note{vault.notes === 1 ? "" : "s"}
              </span>
              <a
                href={obsidianUrl(vault.path)}
                className="shrink-0 underline-offset-2 hover:underline"
                style={{ color: "var(--vb-text-dim)" }}
              >
                Open vault in Obsidian
              </a>
            </div>
          )}

          {/* tasks */}
          <Group
            icon={<ListTodo className="size-3" />}
            title="Work"
            count={openTasks.length}
            action={
              <IconButton
                title="Add a task"
                onClick={() => {
                  const title = window.prompt("Task");
                  if (title?.trim()) void patch({ task: { title: title.trim() } });
                }}
              >
                <Plus className="size-3" />
              </IconButton>
            }
          >
            {openTasks.length === 0 && doneTasks.length === 0 ? (
              <Hint>Nothing tracked yet.</Hint>
            ) : (
              <>
                {openTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={() =>
                      void patch({ task: { ...task, status: "done" } })
                    }
                  />
                ))}
                {doneTasks.slice(-5).map((task) => (
                  <TaskRow key={task.id} task={task} muted />
                ))}
              </>
            )}
          </Group>

          {anchored.length > 0 && selectionLabel && (
            <Group
              icon={<CornerUpLeft className="size-3" />}
              title="Backlinks"
              count={backlinks.length}
            >
              {backlinks.length === 0 ? (
                <Hint>
                  No notes link to <span className="font-mono">{selectionLabel}</span>.
                </Hint>
              ) : (
                backlinks.map((entry, i) => <AnchoredRow key={entry.id ?? i} entry={entry} />)
              )}
            </Group>
          )}

          {anchored.length > 0 && (
            <Group
              icon={<Network className="size-3" />}
              title="Graph memory"
              count={anchored.length}
            >
              {anchored.slice(0, 60).map((entry, i) => (
                <AnchoredRow key={entry.id ?? i} entry={entry} />
              ))}
            </Group>
          )}

          {/* decisions */}
          <Group
            icon={<ScrollText className="size-3" />}
            title="Decisions"
            count={memory.decisions.length}
          >
            {memory.decisions.length === 0 ? (
              <Hint>Agents record architectural choices and why they made them.</Hint>
            ) : (
              memory.decisions
                .slice()
                .reverse()
                .map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onForget={forget} />
                ))
            )}
          </Group>

          {/* conventions */}
          <Group
            icon={<Check className="size-3" />}
            title="Conventions"
            count={memory.conventions.length}
          >
            {memory.conventions.length === 0 ? (
              <Hint>Rules the agents will follow when writing code here.</Hint>
            ) : (
              memory.conventions
                .slice()
                .reverse()
                .map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onForget={forget} />
                ))
            )}
          </Group>

          {/* facts */}
          <Group
            icon={<Brain className="size-3" />}
            title="Known facts"
            count={memory.facts.length}
          >
            {memory.facts.length === 0 ? (
              <Hint>Non-obvious truths about the codebase, learned as agents work.</Hint>
            ) : (
              memory.facts
                .slice()
                .reverse()
                .slice(0, 40)
                .map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onForget={forget} />
                ))
            )}
          </Group>

          {/* suggestions */}
          <Group
            icon={<Lightbulb className="size-3" />}
            title="Suggestions"
            count={openSuggestions.length}
          >
            {openSuggestions.length === 0 ? (
              <Hint>Ideas the agents noted but did not act on.</Hint>
            ) : (
              openSuggestions
                .slice()
                .reverse()
                .map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    onForget={forget}
                    onResolve={() => void patch({ resolveEntryId: entry.id })}
                  />
                ))
            )}
          </Group>

          <div
            className="pb-2 font-mono text-[11px]"
            style={{ color: "var(--vb-text-faint)" }}
          >
            {memory.stats.turns} run{memory.stats.turns === 1 ? "" : "s"} ·{" "}
            {Object.keys(memory.files).length} files indexed

          </div>
        </div>
      </div>
    </div>
  );
}

function Group({
  icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cx("size-3 transition-transform", open && "rotate-90")}
            style={{ color: "var(--vb-text-faint)" }}
          />
          <span style={{ color: "var(--vb-text-faint)" }}>{icon}</span>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.04em]"
            style={{ color: "var(--vb-text-dim)" }}
          >
            {title}
          </span>
          {count > 0 && (
            <span
              className="rounded px-1 font-mono text-[11px]"
              style={{
                background: "var(--vb-fill)",
                color: "var(--vb-text-faint)",
              }}
            >
              {count}
            </span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="flex flex-col gap-0.5 pl-4">{children}</div>}
    </section>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="py-1 text-[11px] leading-relaxed"
      style={{ color: "var(--vb-text-faint)" }}
    >
      {children}
    </p>
  );
}

function AnchoredRow({ entry }: { entry: AnchoredEntry }) {
  const graph = useViberon((s) => s.graph);
  const repoKey = useViberon((s) => s.repoKey);
  return (
    <div className="flex items-start gap-1.5 rounded px-1 py-1 hover:bg-[var(--vb-hover)]">
      <span className="mt-[1px] w-[58px] shrink-0 truncate font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
        {entry.kind}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="text-[11.5px] leading-relaxed"
          style={{ color: entry.stale ? "var(--vb-text-dim)" : "var(--vb-text)" }}
        >
          {entry.text}
          {entry.stale && (
            <span className="ml-1.5 text-[10.5px]" style={{ color: "var(--vb-amber)" }} title="The code this is anchored to has changed since it was recorded">
              may be outdated
            </span>
          )}
        </p>
        {entry.anchors.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.anchors.slice(0, 4).map((anchor) => {
              const node = graph?.nodes.find((n) => n.id === anchor);
              const label = node ? node.name : anchor.split("/").pop();
              return (
                <button
                  key={anchor}
                  type="button"
                  title={node ? `${node.file}:${node.startLine}` : anchor}
                  onClick={() => {
                    const store = useViberon.getState();
                    store.setAppMode("ide");
                    if (node) store.selectNode(node.id);
                    void loadFile(repoKey, node ? node.file : anchor);
                  }}
                  className="rounded px-1 font-mono text-[11px] hover:bg-[var(--vb-hover)]"
                  style={{ background: "var(--vb-fill)", color: "var(--vb-text-dim)" }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry,
  onForget,
  onResolve,
}: {
  entry: MemoryEntry;
  onForget: (id: string) => void;
  onResolve?: () => void;
}) {
  return (
    <div className="group flex items-start gap-1.5 rounded px-1 py-1 transition-colors hover:bg-[var(--vb-hover)]">
      <span className="mt-[6px]">
        <Dot size={4} color="var(--vb-text-faint)" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--vb-text)" }}>
          {entry.text}
        </p>
        {entry.why && (
          <p
            className="mt-0.5 text-[11px] leading-relaxed"
            style={{ color: "var(--vb-text-faint)" }}
          >
            {entry.why}
          </p>
        )}
        {entry.files && entry.files.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.files.slice(0, 3).map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => useViberon.getState().openTab(file)}
                className="rounded px-1 font-mono text-[11px] transition-colors hover:bg-[var(--vb-hover)]"
                style={{
                  background: "var(--vb-fill)",
                  color: "var(--vb-text-dim)",
                }}
              >
                {file.split("/").pop()}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {onResolve && (
          <IconButton title="Mark handled" onClick={onResolve}>
            <Check className="size-2.5" />
          </IconButton>
        )}
        <IconButton title="Forget this" tone="danger" onClick={() => onForget(entry.id)}>
          <Trash2 className="size-2.5" />
        </IconButton>
      </span>
    </div>
  );
}

function TaskRow({
  task,
  muted = false,
  onToggle,
}: {
  task: MemoryTask;
  muted?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      className={cx(
        "flex items-start gap-1.5 rounded px-1 py-1",
        muted && "opacity-45",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        title={onToggle ? "Mark done" : undefined}
        className="mt-[5px] shrink-0"
      >
        <Dot
          size={5}
          color={TASK_COLOR[task.status]}
          live={task.status === "in_progress"}
        />
      </button>
      <div className="min-w-0 flex-1">
        <p
          className={cx("text-[11.5px] leading-relaxed", muted && "line-through")}
          style={{ color: "var(--vb-text)" }}
        >
          {task.title}
        </p>
        {task.role && (
          <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {task.role}
          </span>
        )}
      </div>
    </div>
  );
}

export default MemoryPanel;
