"use client";

/**
 * Chat history.
 *
 * Every thread in this workspace, grouped by recency, with search, rename,
 * and delete. Rendered as a popover so it works identically in the Chat
 * header and the IDE's agent dock — one component, both shells.
 *
 * Deleting is guarded by an inline confirm rather than a modal: losing a
 * conversation to a stray click is unrecoverable, but a dialog for something
 * this frequent would be tedious.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  History,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { groupByRecency, type ConversationMeta } from "@/lib/client/conversations";
import { useViberon } from "@/store/viberon";
import { cx, Dot, Kbd } from "@/components/vibe/primitives";

export function ConversationHistory({
  align = "left",
  compact = false,
}: {
  align?: "left" | "right";
  /** Icon-only trigger, for tight headers like the agent dock. */
  compact?: boolean;
}) {
  const conversations = useViberon((s) => s.conversations);
  const conversationId = useViberon((s) => s.conversationId);
  const streaming = useViberon((s) => s.streaming);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setEditingId(null);
      setConfirmId(null);
      return;
    }
    requestAnimationFrame(() => searchRef.current?.focus());

    function onDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(needle) ||
            c.preview.toLowerCase().includes(needle),
        )
      : conversations;
    return groupByRecency(filtered);
  }, [conversations, query]);

  const activeTitle =
    conversations.find((c) => c.id === conversationId)?.title ?? "New chat";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Chat history"
        aria-label="Chat history"
        aria-expanded={open}
        className={cx(
          "inline-flex items-center gap-1.5 rounded-[4px] transition-colors hover:bg-[var(--vb-hover)]",
          compact ? "size-6 justify-center" : "h-7 px-2",
        )}
        style={{ color: open ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
      >
        <History className="size-3.5 shrink-0" />
        {!compact && (
          <>
            <span className="max-w-[190px] truncate text-[12px]">
              {activeTitle}
            </span>
            {conversations.length > 0 && (
              <span
                className="rounded px-1 font-mono text-[11px]"
                style={{
                  background: "var(--vb-fill)",
                  color: "var(--vb-text-faint)",
                }}
              >
                {conversations.length}
              </span>
            )}
          </>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Chat history"
          className={cx(
            "vb-pop vb-in absolute top-[calc(100%+6px)] z-50 flex max-h-[62vh] w-[330px] flex-col overflow-hidden rounded-[4px]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div
            className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-2"
            style={{ borderColor: "var(--vb-line-faint)" }}
          >
            <Search
              className="size-3 shrink-0"
              style={{ color: "var(--vb-text-faint)" }}
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              aria-label="Search chats"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--vb-text-faint)]"
              style={{ color: "var(--vb-text-hi)" }}
            />
            <Kbd>esc</Kbd>
          </div>

          <button
            type="button"
            disabled={streaming}
            onClick={() => {
              useViberon.getState().newConversation();
              setOpen(false);
            }}
            title={streaming ? "Stop the current run first" : "Start a new chat"}
            className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2 text-left transition-colors hover:bg-[var(--vb-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "var(--vb-line-faint)" }}
          >
            <Plus className="size-3.5" style={{ color: "var(--vb-accent)" }} />
            <span className="text-[12px]" style={{ color: "var(--vb-text-hi)" }}>
              New chat
            </span>
          </button>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {groups.length === 0 ? (
              <p
                className="px-2 py-6 text-center text-[11.5px]"
                style={{ color: "var(--vb-text-faint)" }}
              >
                {query.trim()
                  ? "No chats match."
                  : "No history yet. Your conversations will appear here."}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="mb-1.5">
                  <div
                    className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.04em]"
                    style={{ color: "var(--vb-text-faint)" }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((meta) => (
                    <ConversationRow
                      key={meta.id}
                      meta={meta}
                      active={meta.id === conversationId}
                      editing={editingId === meta.id}
                      confirming={confirmId === meta.id}
                      streaming={streaming}
                      onOpen={() => {
                        useViberon.getState().switchConversation(meta.id);
                        setOpen(false);
                      }}
                      onStartRename={() => {
                        setConfirmId(null);
                        setEditingId(meta.id);
                      }}
                      onRename={(title) => {
                        useViberon.getState().renameConversation(meta.id, title);
                        setEditingId(null);
                      }}
                      onCancelRename={() => setEditingId(null)}
                      onAskDelete={() => {
                        setEditingId(null);
                        setConfirmId(meta.id);
                      }}
                      onCancelDelete={() => setConfirmId(null)}
                      onConfirmDelete={() => {
                        useViberon.getState().deleteConversation(meta.id);
                        setConfirmId(null);
                      }}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({
  meta,
  active,
  editing,
  confirming,
  streaming,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  meta: ConversationMeta;
  active: boolean;
  editing: boolean;
  confirming: boolean;
  streaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const [draft, setDraft] = useState(meta.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(meta.title);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing, meta.title]);

  if (editing) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-[4px] px-2 py-1.5"
        style={{ background: "var(--vb-accent-soft)" }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRename(draft);
            if (e.key === "Escape") onCancelRename();
          }}
          aria-label="Chat title"
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
          style={{ color: "var(--vb-text-hi)" }}
        />
        <button
          type="button"
          onClick={() => onRename(draft)}
          title="Save"
          style={{ color: "var(--vb-mint)" }}
        >
          <Check className="size-3" />
        </button>
        <button
          type="button"
          onClick={onCancelRename}
          title="Cancel"
          style={{ color: "var(--vb-text-faint)" }}
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div
        className="flex items-center gap-2 rounded-[4px] px-2 py-1.5"
        style={{ background: "var(--vb-del-bg)" }}
      >
        <span
          className="min-w-0 flex-1 truncate text-[11.5px]"
          style={{ color: "var(--vb-rose)" }}
        >
          Delete “{meta.title}”?
        </span>
        <button
          type="button"
          onClick={onConfirmDelete}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
          style={{ background: "var(--vb-rose)", color: "var(--vb-accent-fg)" }}
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onCancelDelete}
          className="text-[11px]"
          style={{ color: "var(--vb-text-dim)" }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "group flex items-center gap-2 rounded-[4px] px-2 py-1.5 transition-colors",
        active ? "" : "hover:bg-[var(--vb-hover)]",
      )}
      style={active ? { background: "var(--vb-accent-soft)" } : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={streaming && !active}
        // The tooltip shows the preview, but the accessible name must be the
        // title — otherwise every row announces as a wall of message text.
        aria-label={`Open chat: ${meta.title}`}
        title={
          streaming && !active
            ? "Stop the current run before switching"
            : meta.preview || meta.title
        }
        className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="mt-[3px] shrink-0">
          {active ? (
            <Dot color="var(--vb-accent)" live={streaming} size={6} />
          ) : (
            <MessageSquare
              className="size-3"
              style={{ color: "var(--vb-text-faint)" }}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[12px]"
            style={{ color: active ? "var(--vb-text-hi)" : "var(--vb-text)" }}
          >
            {meta.title}
          </span>
          {meta.preview && (
            <span
              className="block truncate text-[11px]"
              style={{ color: "var(--vb-text-faint)" }}
            >
              {meta.preview}
            </span>
          )}
        </span>
        <span
          className="mt-[2px] shrink-0 font-mono text-[11px]"
          style={{ color: "var(--vb-text-faint)" }}
        >
          {relativeTime(meta.updatedAt)}
        </span>
      </button>

      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onStartRename}
          title="Rename"
          className="rounded p-0.5 hover:bg-[var(--vb-hover)]"
          style={{ color: "var(--vb-text-faint)" }}
        >
          <Pencil className="size-2.5" />
        </button>
        <button
          type="button"
          onClick={onAskDelete}
          title="Delete"
          className="rounded p-0.5 hover:bg-[var(--vb-hover)]"
          style={{ color: "var(--vb-text-faint)" }}
        >
          <Trash2 className="size-2.5" />
        </button>
      </span>
    </div>
  );
}

/** Compact age label: 4m, 3h, 2d, then a date. */
function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default ConversationHistory;
