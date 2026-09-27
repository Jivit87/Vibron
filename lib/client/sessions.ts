"use client";

/**
 * Client side of multi-session support: talks to `/api/sessions` and keeps
 * the store's session list in step with the server.
 *
 * The server owns sessions (status, queue, locks, ledger); the browser owns
 * their chat threads. Hydration binds the two: the server's sessions are
 * listed, each one's thread is loaded from conversation storage, and the
 * session whose thread is already on screen becomes the active one. A
 * workspace with no session yet gets one for the thread on screen.
 *
 * Mock mode (`?mock=1`) has no server: sessions are created locally so the
 * switcher still works in demos.
 */

import { toast } from "sonner";

import { attachSessionRun, cancelRun, isStreaming, refreshWorkspace } from "@/lib/client/agent-stream";
import { createConversationMeta } from "@/lib/client/conversations";
import { isMockMode } from "@/lib/client/mock-run";
import type {
  SessionConfig,
  SessionListResponse,
  SessionMode,
  SessionSummary,
} from "@/lib/sessions/types";
import { useViberon } from "@/store/viberon";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

let mockCounter = 0;
function mockSession(repoKey: string, input: { title?: string; mode?: SessionMode; conversationId: string }): SessionSummary {
  mockCounter += 1;
  const now = Date.now();
  return {
    id: `ses_mock_${now.toString(36)}_${mockCounter}`,
    repoKey,
    title: input.title?.trim() || `Session ${useViberon.getState().sessions.length + 1}`,
    status: "idle",
    model: useViberon.getState().settings.model,
    mode: input.mode ?? "shared",
    createdAt: now,
    lastActiveAt: now,
    conversationId: input.conversationId,
    runId: null,
    queuePosition: null,
    pendingApprovals: 0,
    ledger: { runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 },
    lockedFiles: [],
    checkpointIds: [],
  };
}

/** Title for a session adopting an existing thread. */
function titleForConversation(conversationId: string): string | undefined {
  const meta = useViberon.getState().conversations.find((c) => c.id === conversationId);
  return meta && meta.title !== "New chat" ? meta.title : undefined;
}

/**
 * Load the workspace's sessions and bind the active one. Safe to call again
 * (e.g. on window focus): it only merges.
 */
export async function hydrateSessions(repoKey: string): Promise<void> {
  if (!repoKey) return;
  const store = useViberon.getState();
  if (isMockMode()) {
    if (store.sessions.length === 0) {
      const summary = mockSession(repoKey, {
        conversationId: store.conversationId || createConversationMeta().id,
        title: titleForConversation(store.conversationId),
      });
      store.setSessions([summary]);
      store.bindActiveSession(summary.id);
    }
    return;
  }

  let list: SessionListResponse;
  try {
    list = await api<SessionListResponse>(`/api/sessions?repoKey=${encodeURIComponent(repoKey)}`);
  } catch {
    return; // A server without sessions: the app keeps working sessionless.
  }
  if (useViberon.getState().repoKey !== repoKey) return;
  useViberon.getState().setSessionLimit(list.config.maxConcurrent);

  if (list.sessions.length === 0) {
    const { conversationId } = useViberon.getState();
    try {
      const { session } = await api<{ session: SessionSummary }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          repoKey,
          conversationId,
          title: titleForConversation(conversationId),
          model: useViberon.getState().settings.model,
        }),
      });
      useViberon.getState().setSessions([session]);
      useViberon.getState().bindActiveSession(session.id);
    } catch {
      // Sessionless fallback.
    }
    return;
  }

  useViberon.getState().setSessions(list.sessions);
  bindOnScreen(list.sessions);
  // Reattach to runs that were live before a reload.
  for (const session of list.sessions) {
    if (session.status === "running" || session.status === "awaiting-approval" || session.status === "queued") {
      void reattachSession(session.id);
    }
  }
}

/** Pick the active session: the current one, the one owning the thread on screen, or the first. */
function bindOnScreen(sessions: SessionSummary[]): void {
  const state = useViberon.getState();
  if (state.activeSessionId && sessions.some((s) => s.id === state.activeSessionId)) return;
  const onScreen = sessions.find((s) => s.conversationId === state.conversationId);
  if (onScreen) {
    state.bindActiveSession(onScreen.id);
    return;
  }
  // The thread on screen (a fresh deep link, or one opened before sessions
  // existed) belongs to no session. Keep it on screen: an idle session adopts
  // it (its previous thread stays in history); if every session is busy, a
  // new one is opened for it.
  const idle = sessions.find((s) => s.status !== "running" && s.status !== "queued" && s.status !== "awaiting-approval");
  if (idle) {
    state.bindActiveSession(idle.id);
    void linkConversation(idle.id, state.conversationId);
    return;
  }
  void createSessionFor(state.conversationId);
}

async function createSessionFor(conversationId: string): Promise<void> {
  const { repoKey, settings } = useViberon.getState();
  try {
    const { session } = await api<{ session: SessionSummary }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repoKey, conversationId, title: titleForConversation(conversationId), model: settings.model }),
    });
    const store = useViberon.getState();
    store.addSession(session);
    store.bindActiveSession(session.id);
  } catch {
    // Stay on the thread; the next hydrate retries.
  }
}

/** Re-pull the list (status, ledger, queue positions). */
export async function refreshSessions(): Promise<void> {
  const { repoKey } = useViberon.getState();
  if (!repoKey || isMockMode()) return;
  try {
    const list = await api<SessionListResponse>(`/api/sessions?repoKey=${encodeURIComponent(repoKey)}`);
    if (useViberon.getState().repoKey !== repoKey) return;
    useViberon.getState().setSessions(list.sessions);
    useViberon.getState().setSessionLimit(list.config.maxConcurrent);
  } catch {
    // Keep what we have.
  }
}

/** Open a new session (optionally isolated in a git worktree) and switch to it. */
export async function createSession(options: { mode?: SessionMode; title?: string } = {}): Promise<void> {
  const state = useViberon.getState();
  if (!state.repoKey) return;
  const conversationId = createConversationMeta().id;
  let session: SessionSummary;
  if (isMockMode()) {
    session = mockSession(state.repoKey, { ...options, conversationId });
  } else {
    try {
      ({ session } = await api<{ session: SessionSummary }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          repoKey: state.repoKey,
          conversationId,
          model: state.settings.model,
          mode: options.mode ?? "shared",
          ...(options.title ? { title: options.title } : {}),
        }),
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  useViberon.getState().addSession(session, { activate: true });
  if (session.mode === "isolated") {
    toast.success("Isolated session ready", {
      description: "It works in its own git worktree. Apply its changes to the workspace when you are happy with them.",
    });
  }
}

export function switchSession(id: string): void {
  useViberon.getState().switchSession(id);
  if (!isMockMode()) void fetch(`/api/sessions/${encodeURIComponent(id)}`).catch(() => {});
}

export async function renameSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) return;
  useViberon.getState().patchSession(id, { title: trimmed });
  if (isMockMode()) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: trimmed }),
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/** Stop a session's run, queued or running. */
export async function stopSession(id: string): Promise<void> {
  await cancelRun(id);
  if (isMockMode()) return;
  await fetch(`/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
}

/**
 * Close a session: stop its run, delete it on the server (which releases its
 * file locks and removes an isolated worktree), and drop it here. The last
 * session is replaced by a fresh one so there is always somewhere to type.
 */
export async function closeSession(id: string): Promise<void> {
  const state = useViberon.getState();
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  if (isStreaming(id)) await cancelRun(id);
  if (!isMockMode()) {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
  useViberon.getState().persistConversation();
  useViberon.getState().removeSession(id);
  if (useViberon.getState().sessions.length === 0) await createSession();
}

/** Revert every file this session changed, and nothing another session did. */
export async function undoSessionChanges(id: string): Promise<void> {
  if (isMockMode()) {
    toast.info("Undo is not available in mock mode.");
    return;
  }
  try {
    const result = await api<{
      restored: number;
      deleted: number;
      conflicts: { path: string; reason: string }[];
      checkpoints: string[];
    }>(`/api/sessions/${encodeURIComponent(id)}/undo`, { method: "POST", body: "{}" });
    if (result.checkpoints.length === 0) {
      toast.info("This session has not changed any files yet.");
      return;
    }
    const changed = result.restored + result.deleted;
    const summary = `${changed} file${changed === 1 ? "" : "s"} reverted`;
    if (result.conflicts.length) {
      toast.warning(`${summary}; ${result.conflicts.length} left alone`, {
        description: result.conflicts
          .slice(0, 4)
          .map((c) => `${c.path}: ${c.reason}`)
          .join("\n"),
        duration: 10_000,
      });
    } else {
      toast.success(summary);
    }
    void refreshWorkspace();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/** Bring an isolated session's worktree change into the workspace. */
export async function applyIsolatedSession(id: string): Promise<void> {
  if (isMockMode()) {
    toast.info("Applying is not available in mock mode.");
    return;
  }
  try {
    const result = await api<{ files: { path: string }[] }>(
      `/api/sessions/${encodeURIComponent(id)}/apply`,
      { method: "POST", body: "{}" },
    );
    if (result.files.length === 0) toast.info("The session has no changes to apply.");
    else toast.success(`Applied ${result.files.length} file${result.files.length === 1 ? "" : "s"} to the workspace`);
    void refreshWorkspace();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/** Save the max-concurrent-runs setting on the server. */
export async function saveSessionLimit(requested: number): Promise<void> {
  const maxConcurrent = Math.max(1, Math.min(12, Math.round(requested)));
  useViberon.getState().setSessionLimit(maxConcurrent);
  if (isMockMode()) return;
  try {
    const { config } = await api<{ config: SessionConfig }>("/api/sessions", {
      method: "PUT",
      body: JSON.stringify({ maxConcurrent }),
    });
    useViberon.getState().setSessionLimit(config.maxConcurrent);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/** Tell the server which thread a session writes to. */
async function linkConversation(id: string, conversationId: string): Promise<void> {
  if (isMockMode() || !conversationId) return;
  await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  }).catch(() => {});
}

/**
 * Keep the server's `conversationId` in step when the active session opens
 * another thread (New chat, history). Returns the unsubscribe.
 */
export function watchSessionConversations(): () => void {
  return useViberon.subscribe((state, previous) => {
    if (!state.activeSessionId) return;
    if (state.activeSessionId !== previous.activeSessionId) return;
    if (state.conversationId === previous.conversationId) return;
    void linkConversation(state.activeSessionId, state.conversationId);
  });
}

/**
 * Show the replay of a session's live run that this page is not streaming
 * (after a reload). Uses the same reader as a live run.
 */
async function reattachSession(id: string): Promise<void> {
  if (isStreaming(id)) return;
  await attachSessionRun(id);
}
