"use client";

/**
 * Session switcher: every agent session in the workspace, with its status.
 *
 * Two shapes over the same actions:
 *  - `tabs` (Chat header): a scrollable tab strip, one tab per session.
 *  - `compact` (IDE agent dock): the active session's name as a dropdown.
 *
 * A session can be created (shared, or isolated in its own git worktree),
 * switched to, renamed inline (double-click, or "Rename"), stopped, undone
 * (reverts only that session's files), applied (isolated), and closed.
 * A background session that needs an approval or finished while unseen
 * carries an attention marker until you open it.
 */

import { useEffect, useRef, useState } from "react";
import { GitBranch, MoreHorizontal, Plus, X } from "lucide-react";

import {
  applyIsolatedSession,
  closeSession,
  createSession,
  renameSession,
  stopSession,
  switchSession,
  undoSessionChanges,
} from "@/lib/client/sessions";
import type { SessionStatus } from "@/lib/sessions/types";
import { useViberon, type ClientSession } from "@/store/viberon";
import { cx, Dot, formatCost, formatTokens, MenuItem, Popover } from "@/components/vibe/primitives";

const STATUS: Record<SessionStatus, { label: string; color: string; live: boolean }> = {
  idle: { label: "Idle", color: "var(--vb-text-faint)", live: false },
  queued: { label: "Queued", color: "var(--vb-text-dim)", live: true },
  running: { label: "Running", color: "var(--vb-accent)", live: true },
  "awaiting-approval": { label: "Needs approval", color: "var(--vb-amber)", live: true },
  done: { label: "Done", color: "var(--vb-mint)", live: false },
  error: { label: "Error", color: "var(--vb-rose)", live: false },
};

function statusText(session: ClientSession): string {
  const base = STATUS[session.status]?.label ?? session.status;
  if (session.status === "queued" && session.queuePosition) return `${base} #${session.queuePosition}`;
  return base;
}

function isBusy(session: ClientSession): boolean {
  return session.status === "running" || session.status === "queued" || session.status === "awaiting-approval";
}

export function StatusBadge({ session }: { session: ClientSession }) {
  const tone = STATUS[session.status] ?? STATUS.idle;
  return (
    <span className="relative inline-flex" title={statusText(session)} aria-label={statusText(session)}>
      <Dot color={tone.color} live={tone.live} size={6} />
      {session.attention && (
        <span
          className="absolute -right-[3px] -top-[3px] size-[5px] rounded-full"
          style={{ background: session.attention === "error" ? "var(--vb-rose)" : "var(--vb-amber)" }}
          aria-hidden
        />
      )}
    </span>
  );
}

export function SessionSwitcher({ variant = "tabs" }: { variant?: "tabs" | "compact" }) {
  const sessions = useViberon((s) => s.sessions);
  const activeId = useViberon((s) => s.activeSessionId);
  const limit = useViberon((s) => s.sessionLimit);
  const [editing, setEditing] = useState<string | null>(null);

  if (sessions.length === 0) return null;
  const running = sessions.filter((s) => s.status === "running" || s.status === "awaiting-approval").length;
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  if (variant === "compact") {
    const attention = sessions.filter((s) => s.id !== active.id && s.attention).length;
    return (
      <div className="flex min-w-0 items-center">
        {editing === active.id ? (
          <RenameInput session={active} onDone={() => setEditing(null)} />
        ) : (
          <Popover
            label={
              <span className="flex items-center gap-1.5">
                <StatusBadge session={active} />
                <span className="truncate">{active.title}</span>
                {attention > 0 && (
                  <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-amber)" }}>
                    +{attention}
                  </span>
                )}
              </span>
            }
            title="Switch session"
            placement="bottom"
            align="right"
            width={280}
          >
            {(close) => (
              <SessionMenu
                sessions={sessions}
                activeId={active.id}
                running={running}
                limit={limit}
                onRename={(id) => {
                  close();
                  setEditing(id);
                }}
                close={close}
              />
            )}
          </Popover>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Agent sessions">
      <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            active={session.id === active.id}
            editing={editing === session.id}
            onEdit={() => setEditing(session.id)}
            onDoneEditing={() => setEditing(null)}
          />
        ))}
      </div>
      <NewSessionButton running={running} limit={limit} />
    </div>
  );
}

function SessionTab({
  session,
  active,
  editing,
  onEdit,
  onDoneEditing,
}: {
  session: ClientSession;
  active: boolean;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
}) {
  if (editing) return <RenameInput session={session} onDone={onDoneEditing} />;
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cx(
        "group flex h-[22px] max-w-[190px] shrink-0 items-center gap-1.5 rounded-[3px] pl-1.5 pr-0.5 text-[11.5px]",
        active ? "bg-[var(--vb-active)]" : "hover:bg-[var(--vb-hover)]",
      )}
      style={{ color: active ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
      title={`${session.title} · ${statusText(session)}${session.mode === "isolated" ? " · isolated worktree" : ""}`}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5"
        onClick={() => switchSession(session.id)}
        onDoubleClick={onEdit}
      >
        <StatusBadge session={session} />
        {session.mode === "isolated" && <GitBranch className="size-3 shrink-0 opacity-70" />}
        <span className={cx("truncate", session.attention && "font-semibold")}>{session.title}</span>
        {session.status === "queued" && session.queuePosition && (
          <span className="font-mono text-[10.5px]">#{session.queuePosition}</span>
        )}
      </button>
      <SessionActions session={session} onRename={onEdit} />
      <button
        type="button"
        onClick={() => void closeSession(session.id)}
        title={isBusy(session) ? "Stop and close this session" : "Close this session"}
        aria-label={`Close ${session.title}`}
        className={cx(
          "inline-flex size-[16px] shrink-0 items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)]",
          !active && "opacity-0 group-hover:opacity-100",
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function SessionActions({ session, onRename }: { session: ClientSession; onRename: () => void }) {
  return (
    <Popover
      label={<MoreHorizontal className="size-3" />}
      title="Session actions"
      placement="bottom"
      align="right"
      chevron={false}
      width={240}
    >
      {(close) => (
        <SessionItemActions
          session={session}
          close={close}
          onRename={() => {
            close();
            onRename();
          }}
        />
      )}
    </Popover>
  );
}

function SessionItemActions({
  session,
  close,
  onRename,
}: {
  session: ClientSession;
  close: () => void;
  onRename: () => void;
}) {
  const busy = isBusy(session);
  const ledger = session.ledger;
  return (
    <div className="flex flex-col">
      {ledger && ledger.runs > 0 && (
        <p className="px-2.5 pb-1 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
          {ledger.runs} run{ledger.runs === 1 ? "" : "s"} · {formatTokens(ledger.tokensIn + ledger.tokensOut)} tok ·{" "}
          {formatCost(ledger.costUsd)}
        </p>
      )}
      <MenuItem active={false} onClick={onRename} title="Rename" />
      <MenuItem
        active={false}
        disabled={!busy}
        onClick={() => {
          close();
          void stopSession(session.id);
        }}
        title="Stop run"
        hint={session.status === "queued" ? "Leave the queue" : undefined}
      />
      <MenuItem
        active={false}
        disabled={busy}
        onClick={() => {
          close();
          void undoSessionChanges(session.id);
        }}
        title="Undo this session's changes"
        hint="Reverts only files this session wrote"
      />
      {session.mode === "isolated" && (
        <MenuItem
          active={false}
          disabled={busy}
          onClick={() => {
            close();
            void applyIsolatedSession(session.id);
          }}
          title="Apply to workspace"
          hint="git apply the worktree's change"
        />
      )}
      <MenuItem
        active={false}
        onClick={() => {
          close();
          void closeSession(session.id);
        }}
        title={busy ? "Stop and close" : "Close session"}
        hint={session.mode === "isolated" ? "Removes its worktree" : undefined}
      />
    </div>
  );
}

function SessionMenu({
  sessions,
  activeId,
  running,
  limit,
  onRename,
  close,
}: {
  sessions: ClientSession[];
  activeId: string;
  running: number;
  limit: number;
  onRename: (id: string) => void;
  close: () => void;
}) {
  const active = sessions.find((s) => s.id === activeId);
  return (
    <div className="flex flex-col">
      <p className="vb-label px-2.5 pb-1">
        Sessions · {running}/{limit} running
      </p>
      {sessions.map((session) => (
        <MenuItem
          key={session.id}
          active={session.id === activeId}
          onClick={() => {
            close();
            switchSession(session.id);
          }}
          title={session.title}
          hint={`${statusText(session)}${session.mode === "isolated" ? " · isolated" : ""}${
            session.attention === "approval" ? " · waiting for you" : ""
          }`}
          trailing={<StatusBadge session={session} />}
        />
      ))}
      <div className="my-1 border-t" style={{ borderColor: "var(--vb-line)" }} />
      <MenuItem
        active={false}
        onClick={() => {
          close();
          void createSession();
        }}
        title="New session"
        hint={running >= limit ? `Runs queue beyond ${limit} at once` : undefined}
      />
      <MenuItem
        active={false}
        onClick={() => {
          close();
          void createSession({ mode: "isolated" });
        }}
        title="New isolated session"
        hint="Works in its own git worktree"
      />
      {active && (
        <>
          <div className="my-1 border-t" style={{ borderColor: "var(--vb-line)" }} />
          <p className="vb-label px-2.5 pb-1">{active.title}</p>
          <SessionItemActions session={active} close={close} onRename={() => onRename(active.id)} />
        </>
      )}
    </div>
  );
}

function NewSessionButton({ running, limit }: { running: number; limit: number }) {
  return (
    <Popover
      label={<Plus className="size-3.5" />}
      title="New session"
      placement="bottom"
      align="left"
      chevron={false}
      width={250}
    >
      {(close) => (
        <div className="flex flex-col">
          <MenuItem
            active={false}
            onClick={() => {
              close();
              void createSession();
            }}
            title="New session"
            hint={
              running >= limit
                ? `${running}/${limit} running: its runs will queue`
                : "Shares the workspace; files are locked per session"
            }
          />
          <MenuItem
            active={false}
            onClick={() => {
              close();
              void createSession({ mode: "isolated" });
            }}
            title="New isolated session"
            hint="Works in its own git worktree; apply when ready"
          />
        </div>
      )}
    </Popover>
  );
}

function RenameInput({ session, onDone }: { session: ClientSession; onDone: () => void }) {
  const [value, setValue] = useState(session.title);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  function commit(save: boolean) {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() && value.trim() !== session.title) void renameSession(session.id, value);
    onDone();
  }

  return (
    <input
      ref={ref}
      value={value}
      maxLength={80}
      aria-label="Session name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(true);
        if (event.key === "Escape") commit(false);
      }}
      className="h-[22px] w-[150px] shrink-0 rounded-[3px] border px-1.5 text-[11.5px] outline-none"
      style={{ borderColor: "var(--vb-accent-line)", background: "var(--vb-bg-input)", color: "var(--vb-text-hi)" }}
    />
  );
}

/** "Waiting for a run slot" line for the active session while its run is queued. */
export function QueuedNotice() {
  const session = useViberon((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const limit = useViberon((s) => s.sessionLimit);
  if (!session || session.status !== "queued") return null;
  return (
    <p className="flex items-center gap-1.5 pb-1.5 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
      <Dot color="var(--vb-text-dim)" live size={5} />
      Queued{session.queuePosition ? ` #${session.queuePosition}` : ""}: {limit} session
      {limit === 1 ? " is" : "s are"} already running. It starts when a slot frees up.
    </p>
  );
}

export default SessionSwitcher;
