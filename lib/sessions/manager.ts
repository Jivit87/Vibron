/**
 * The session manager: several concurrent agent sessions per workspace.
 *
 * A session is a long-lived lane of work with its own chat thread, model,
 * run state, event stream, approval queue and token ledger. Sessions share
 * the workspace's graph and memory (both serialized for concurrent writers)
 * and are kept from clobbering each other's files by the cross-session file
 * lock (`file-locks.ts`). An *isolated* session goes further and works in
 * its own git worktree.
 *
 * What lives here:
 *  - the registry: create, list, rename, cancel, delete, and sweeping away
 *    abandoned sessions;
 *  - the run scheduler: at most `maxConcurrent` runs execute per workspace,
 *    the rest wait FIFO with their queue position streamed to the client;
 *  - per-session bookkeeping fed from the run's own events: status,
 *    pending approvals, the ledger, and a bounded replay buffer so a client
 *    that reconnects (or switches back) gets the run's events again.
 *
 * Everything is in memory on globalThis, like the run registry: a session
 * does not outlive the server process, but its chat thread (client-side) does.
 */

import { randomUUID } from "node:crypto";

import type { OrchestrationEvent, RunStatus } from "@/lib/agents/events";
import { listLocks, releaseOwner } from "@/lib/sessions/file-locks";
import type {
  SessionConfig,
  SessionLedger,
  SessionMode,
  SessionStatus,
  SessionSummary,
} from "@/lib/sessions/types";

/* ------------------------------- config ---------------------------------- */

const MIN_CONCURRENT = 1;
const MAX_CONCURRENT = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export function defaultSessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  return normalizeConfig({
    maxConcurrent: Number(env.VIBERON_MAX_SESSIONS) || 3,
    idleTtlMs: Number(env.VIBERON_SESSION_TTL_MS) || DAY_MS,
  });
}

export function normalizeConfig(raw: Partial<SessionConfig>, base?: SessionConfig): SessionConfig {
  const fallback = base ?? { maxConcurrent: 3, idleTtlMs: DAY_MS };
  const max = Number(raw.maxConcurrent);
  const ttl = Number(raw.idleTtlMs);
  return {
    maxConcurrent: Number.isFinite(max)
      ? Math.max(MIN_CONCURRENT, Math.min(MAX_CONCURRENT, Math.round(max)))
      : fallback.maxConcurrent,
    idleTtlMs: Number.isFinite(ttl) && ttl > 0 ? Math.max(60_000, Math.round(ttl)) : fallback.idleTtlMs,
  };
}

/* ------------------------------- records --------------------------------- */

/** Replay buffer cap per session; the first event (run_start) is always kept. */
const MAX_BUFFERED_EVENTS = 4000;
const MAX_TITLE = 80;

interface Listener {
  onEvent: (event: OrchestrationEvent) => void;
  onEnd: () => void;
}

interface Waiter {
  sessionId: string;
  shared: boolean;
  exclusive: boolean;
  grant: (granted: boolean) => void;
  notify: (position: number) => void;
}

interface SessionRecord {
  id: string;
  repoKey: string;
  title: string;
  status: SessionStatus;
  model: string;
  mode: SessionMode;
  createdAt: number;
  lastActiveAt: number;
  conversationId: string | null;
  runId: string | null;
  error?: string;
  worktree?: { path: string; repoKey: string; repoRoot: string };
  approvals: Set<string>;
  /** Ledger of finished runs; the live run's numbers are added on read. */
  settled: SessionLedger;
  live: Omit<SessionLedger, "runs"> | null;
  checkpointIds: string[];
  /** Current (or last) run's events, for replay. */
  events: OrchestrationEvent[];
  listeners: Set<Listener>;
  streamEnded: boolean;
}

export interface WorktreeDeps {
  /** Workspace root on disk for a repo key, or null for store workspaces. */
  rootFor: (repoKey: string) => Promise<string | null>;
  create: (repoRoot: string, name: string) => Promise<string>;
  /** Register a directory as a workspace; returns its repo key. */
  register: (dir: string) => Promise<string>;
  remove: (repoRoot: string, dir: string) => Promise<boolean>;
}

export interface SessionManagerDeps {
  now?: () => number;
  /** Stop a run (default: the harness run registry). */
  cancelRun?: (runId: string) => boolean;
  /** Whether a run is still registered (default: the harness run registry). */
  isRunLive?: (runId: string) => boolean;
  worktrees?: WorktreeDeps;
  config?: Partial<SessionConfig>;
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

const ACTIVE: SessionStatus[] = ["queued", "running", "awaiting-approval"];

function emptyLedger(): SessionLedger {
  return { runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };
}

function cleanTitle(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, MAX_TITLE);
}

/** Session status for a finished run. */
export function statusForRun(status: RunStatus | "error"): SessionStatus {
  if (status === "cancelled") return "idle";
  if (status === "failed" || status === "error") return "error";
  return "done";
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  /** repoKey → sessions holding a run slot. */
  private readonly running = new Map<string, Map<string, { shared: boolean; exclusive: boolean }>>();
  /** repoKey → FIFO of runs waiting for a slot. */
  private readonly queues = new Map<string, Waiter[]>();
  private config: SessionConfig;
  private readonly now: () => number;

  constructor(private readonly deps: SessionManagerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.config = normalizeConfig(deps.config ?? {}, defaultSessionConfig());
  }

  /* ----------------------------- config ----------------------------- */

  getConfig(): SessionConfig {
    return { ...this.config };
  }

  /** Change the limits. Raising the cap starts queued runs at once. */
  configure(patch: Partial<SessionConfig>): SessionConfig {
    this.config = normalizeConfig(patch, this.config);
    for (const repoKey of this.queues.keys()) this.pump(repoKey);
    return this.getConfig();
  }

  /* ---------------------------- registry ---------------------------- */

  async create(input: {
    repoKey: string;
    title?: string;
    model?: string;
    conversationId?: string | null;
    mode?: SessionMode;
  }): Promise<SessionSummary> {
    if (!input.repoKey) throw new SessionError("repoKey is required", 400);
    const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = this.now();
    const count = this.list(input.repoKey).length;
    const record: SessionRecord = {
      id,
      repoKey: input.repoKey,
      title: cleanTitle(input.title, `Session ${count + 1}`),
      status: "idle",
      model: typeof input.model === "string" && input.model ? input.model : "auto",
      mode: input.mode === "isolated" ? "isolated" : "shared",
      createdAt: now,
      lastActiveAt: now,
      conversationId: input.conversationId ?? null,
      runId: null,
      approvals: new Set(),
      settled: emptyLedger(),
      live: null,
      checkpointIds: [],
      events: [],
      listeners: new Set(),
      streamEnded: true,
    };

    if (record.mode === "isolated") {
      record.worktree = await this.createWorktree(input.repoKey, id);
    }
    this.sessions.set(id, record);
    return this.summarize(record);
  }

  private async createWorktree(repoKey: string, id: string) {
    const deps = this.deps.worktrees;
    if (!deps) throw new SessionError("Isolated sessions are not available here.", 400);
    const repoRoot = await deps.rootFor(repoKey);
    if (!repoRoot) {
      throw new SessionError(
        "Isolated sessions need a workspace on disk that is a git repository with at least one commit.",
        400,
      );
    }
    let dir: string;
    try {
      dir = await deps.create(repoRoot, `session-${id}`);
    } catch (error) {
      throw new SessionError(error instanceof Error ? error.message : String(error), 400);
    }
    try {
      return { path: dir, repoKey: await deps.register(dir), repoRoot };
    } catch (error) {
      await deps.remove(repoRoot, dir).catch(() => false);
      throw new SessionError(error instanceof Error ? error.message : String(error), 500);
    }
  }

  get(id: string): SessionSummary | undefined {
    const record = this.sessions.get(id);
    return record ? this.summarize(record) : undefined;
  }

  /** Sessions of one workspace, oldest first (stable tab order). */
  list(repoKey: string): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((s) => s.repoKey === repoKey)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((s) => this.summarize(s));
  }

  /** Counts for the workspace header: runs executing and waiting. */
  load(repoKey: string): { running: number; queued: number } {
    return {
      running: this.running.get(repoKey)?.size ?? 0,
      queued: this.queues.get(repoKey)?.length ?? 0,
    };
  }

  update(
    id: string,
    patch: { title?: unknown; model?: unknown; conversationId?: unknown },
  ): SessionSummary {
    const record = this.require(id);
    if (patch.title !== undefined) record.title = cleanTitle(patch.title, record.title);
    if (typeof patch.model === "string" && patch.model.trim()) record.model = patch.model.trim();
    if (patch.conversationId === null || typeof patch.conversationId === "string") {
      record.conversationId = patch.conversationId || null;
    }
    record.lastActiveAt = this.now();
    return this.summarize(record);
  }

  /** Mark a session as looked at (switching to it keeps it from being swept). */
  touch(id: string): void {
    const record = this.sessions.get(id);
    if (record) record.lastActiveAt = this.now();
  }

  /**
   * Stop whatever the session is doing: a queued run leaves the queue, a
   * running one is cancelled through the run registry. True if anything
   * was stopped.
   */
  cancel(id: string): boolean {
    const record = this.require(id);
    const dequeued = this.dequeue(id);
    const runId = record.runId;
    const cancelled = runId ? (this.deps.cancelRun?.(runId) ?? false) : false;
    if (dequeued && !cancelled) {
      record.status = "idle";
      record.runId = null;
    }
    record.lastActiveAt = this.now();
    return dequeued || cancelled;
  }

  /** Cancel, release locks and the run slot, remove the worktree, forget it. */
  async delete(id: string): Promise<boolean> {
    const record = this.sessions.get(id);
    if (!record) return false;
    this.cancel(id);
    this.releaseSlot(record);
    releaseOwner(id);
    this.sessions.delete(id);
    this.endStream(record);
    if (record.worktree && this.deps.worktrees) {
      await this.deps.worktrees
        .remove(record.worktree.repoRoot, record.worktree.path)
        .catch(() => false);
    }
    return true;
  }

  /**
   * Clean up abandoned sessions:
   *  - a session whose run vanished from the run registry (the request died
   *    without reaching its `finally`) is marked `error` and unlocked;
   *  - an inactive session untouched for `idleTtlMs` is deleted.
   * Returns the ids deleted.
   */
  async sweep(): Promise<string[]> {
    const now = this.now();
    const removed: string[] = [];
    for (const record of [...this.sessions.values()]) {
      if (
        (record.status === "running" || record.status === "awaiting-approval") &&
        record.runId &&
        this.deps.isRunLive &&
        !this.deps.isRunLive(record.runId)
      ) {
        this.finishRun(record.id, "error", "The run was interrupted.");
      }
      if (ACTIVE.includes(record.status)) continue;
      if (now - record.lastActiveAt < this.config.idleTtlMs) continue;
      if (await this.delete(record.id)) removed.push(record.id);
    }
    return removed;
  }

  /* ------------------------------ runs ------------------------------ */

  /**
   * Bind a new run to the session. Refused (409) while the session already
   * has one: a session is one lane of work; open another session instead.
   */
  beginRun(id: string, runId: string, input: { model?: string } = {}): SessionSummary {
    const record = this.require(id);
    if (ACTIVE.includes(record.status) && record.runId) {
      throw new SessionError(
        `Session "${record.title}" is already running. Stop it, or start another session.`,
        409,
      );
    }
    record.runId = runId;
    record.status = "queued";
    record.error = undefined;
    record.approvals.clear();
    record.live = null;
    if (input.model) record.model = input.model;
    record.lastActiveAt = this.now();
    // A fresh replay buffer: reconnecting shows this run, not the last one.
    this.endStream(record);
    record.events = [];
    record.streamEnded = false;
    return this.summarize(record);
  }

  addCheckpoint(id: string, checkpointId: string): void {
    const record = this.sessions.get(id);
    if (record) record.checkpointIds = [checkpointId, ...record.checkpointIds.filter((c) => c !== checkpointId)];
  }

  /**
   * Wait for a run slot. Resolves true once the run may execute, or false
   * when it was cancelled while waiting. `shared` runs edit the workspace
   * checkout; an `exclusive` one (fix mode, which snapshots and restores the
   * whole tree) runs only when no other shared run does, and blocks them
   * meanwhile. `emit` receives `session` events: queued with a position,
   * then running.
   */
  acquireSlot(
    id: string,
    options: {
      exclusive?: boolean;
      signal?: AbortSignal;
      emit?: (event: OrchestrationEvent) => void;
    } = {},
  ): Promise<boolean> {
    const record = this.require(id);
    const emit = options.emit ?? (() => {});
    const shared = record.mode === "shared";
    const waiter: Waiter = {
      sessionId: id,
      shared,
      exclusive: shared && Boolean(options.exclusive),
      grant: () => {},
      notify: (position) => {
        const current = this.sessions.get(id);
        if (current) current.status = "queued";
        emit({
          type: "session",
          sessionId: id,
          status: "queued",
          position,
          message:
            position === 1
              ? "Waiting for a free run slot."
              : `Waiting for a free run slot (${position - 1} ahead).`,
        });
      },
    };

    return new Promise<boolean>((resolve) => {
      if (options.signal?.aborted) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        if (this.dequeue(id)) resolve(false);
      };
      waiter.grant = (granted) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (granted) {
          const current = this.sessions.get(id);
          if (current) current.status = current.approvals.size ? "awaiting-approval" : "running";
          emit({ type: "session", sessionId: id, status: "running" });
        }
        resolve(granted);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const queue = this.queues.get(record.repoKey) ?? [];
      queue.push(waiter);
      this.queues.set(record.repoKey, queue);
      const before = queue.length;
      this.pump(record.repoKey);
      // Still waiting: tell the client where it stands.
      if (queue.includes(waiter) && before === queue.length) waiter.notify(queue.indexOf(waiter) + 1);
    });
  }

  /** Feed one of the session's run events: status, approvals, ledger, replay. */
  observe(id: string, event: OrchestrationEvent): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.lastActiveAt = this.now();
    switch (event.type) {
      case "approval_request":
        record.approvals.add(event.approvalId);
        record.status = "awaiting-approval";
        break;
      case "approval_resolved":
        record.approvals.delete(event.approvalId);
        if (record.approvals.size === 0 && record.status === "awaiting-approval") record.status = "running";
        break;
      case "ledger":
        record.live = {
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          tokensCached: event.tokensCached,
          costUsd: event.costUsd,
        };
        break;
      case "error":
        if (event.fatal) record.error = event.message;
        break;
      default:
        break;
    }
    record.events.push(event);
    if (record.events.length > MAX_BUFFERED_EVENTS) record.events.splice(1, 1);
    for (const listener of record.listeners) listener.onEvent(event);
  }

  /** The run ended: settle the ledger, free the slot, release the locks. */
  finishRun(id: string, status: RunStatus | "error", error?: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    this.dequeue(id);
    if (record.live) {
      record.settled = {
        runs: record.settled.runs + 1,
        tokensIn: record.settled.tokensIn + record.live.tokensIn,
        tokensOut: record.settled.tokensOut + record.live.tokensOut,
        tokensCached: record.settled.tokensCached + record.live.tokensCached,
        costUsd: record.settled.costUsd + record.live.costUsd,
      };
    } else if (record.runId) {
      record.settled = { ...record.settled, runs: record.settled.runs + 1 };
    }
    record.live = null;
    record.status = statusForRun(status);
    if (error) record.error = error;
    else if (record.status !== "error") record.error = undefined;
    record.approvals.clear();
    record.runId = null;
    record.lastActiveAt = this.now();
    this.releaseSlot(record);
    releaseOwner(id);
    this.endStream(record);
  }

  /**
   * Replay the current (or last) run's buffered events, then stream the live
   * tail; `onEnd` fires when the run finishes (at once if it already has).
   */
  subscribe(
    id: string,
    onEvent: (event: OrchestrationEvent) => void,
    onEnd: () => void,
  ): () => void {
    const record = this.require(id);
    for (const event of record.events) onEvent(event);
    if (record.streamEnded) {
      onEnd();
      return () => {};
    }
    const listener: Listener = { onEvent, onEnd };
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Test helper. */
  reset(): void {
    for (const record of this.sessions.values()) this.endStream(record);
    this.sessions.clear();
    this.running.clear();
    this.queues.clear();
  }

  /* ---------------------------- internals --------------------------- */

  private require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new SessionError("Unknown session", 404);
    return record;
  }

  private canGrant(repoKey: string, waiter: Waiter): boolean {
    const active = this.running.get(repoKey);
    if (!active || active.size === 0) return true;
    if (active.size >= this.config.maxConcurrent) return false;
    if (!waiter.shared) return true;
    const slots = [...active.values()].filter((slot) => slot.shared);
    if (waiter.exclusive) return slots.length === 0;
    return !slots.some((slot) => slot.exclusive);
  }

  /** Grant slots strictly in FIFO order, then re-number whoever still waits. */
  private pump(repoKey: string): void {
    const queue = this.queues.get(repoKey);
    if (!queue) return;
    const granted: Waiter[] = [];
    while (queue.length > 0 && this.canGrant(repoKey, queue[0])) {
      const waiter = queue.shift()!;
      const active = this.running.get(repoKey) ?? new Map();
      active.set(waiter.sessionId, { shared: waiter.shared, exclusive: waiter.exclusive });
      this.running.set(repoKey, active);
      granted.push(waiter);
    }
    if (queue.length === 0) this.queues.delete(repoKey);
    for (const waiter of granted) waiter.grant(true);
    if (granted.length > 0) queue.forEach((waiter, index) => waiter.notify(index + 1));
  }

  private dequeue(id: string): boolean {
    const record = this.sessions.get(id);
    if (!record) return false;
    const queue = this.queues.get(record.repoKey);
    const index = queue?.findIndex((w) => w.sessionId === id) ?? -1;
    if (!queue || index === -1) return false;
    const [waiter] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(record.repoKey);
    waiter.grant(false);
    queue.slice(index).forEach((w, i) => w.notify(index + i + 1));
    return true;
  }

  private releaseSlot(record: SessionRecord): void {
    const active = this.running.get(record.repoKey);
    if (!active?.delete(record.id)) return;
    if (active.size === 0) this.running.delete(record.repoKey);
    this.pump(record.repoKey);
  }

  private endStream(record: SessionRecord): void {
    record.streamEnded = true;
    const listeners = [...record.listeners];
    record.listeners.clear();
    for (const listener of listeners) listener.onEnd();
  }

  private summarize(record: SessionRecord): SessionSummary {
    const live = record.live;
    const queue = this.queues.get(record.repoKey);
    const position = queue ? queue.findIndex((w) => w.sessionId === record.id) : -1;
    return {
      id: record.id,
      repoKey: record.repoKey,
      title: record.title,
      status: record.status,
      model: record.model,
      mode: record.mode,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      conversationId: record.conversationId,
      runId: record.runId,
      queuePosition: position === -1 ? null : position + 1,
      pendingApprovals: record.approvals.size,
      ledger: {
        runs: record.settled.runs + (record.runId && live ? 1 : 0),
        tokensIn: record.settled.tokensIn + (live?.tokensIn ?? 0),
        tokensOut: record.settled.tokensOut + (live?.tokensOut ?? 0),
        tokensCached: record.settled.tokensCached + (live?.tokensCached ?? 0),
        costUsd: record.settled.costUsd + (live?.costUsd ?? 0),
      },
      lockedFiles: listLocks()
        .filter((lock) => lock.ownerId === record.id)
        .map((lock) => lock.path)
        .sort(),
      checkpointIds: [...record.checkpointIds],
      ...(record.worktree ? { worktree: { path: record.worktree.path, repoKey: record.worktree.repoKey } } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  /** Where an isolated session's worktree lives (and its source checkout). */
  worktreeOf(id: string): { path: string; repoKey: string; repoRoot: string } | undefined {
    return this.sessions.get(id)?.worktree;
  }
}
