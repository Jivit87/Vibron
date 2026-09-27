/**
 * Shapes shared by the session manager, the sessions API and the browser.
 * Type-only: safe to import from client code.
 */

/**
 * Where a session is in its life.
 *  - `idle`: created, or its last run was cancelled; ready for a prompt.
 *  - `queued`: a run is waiting for a slot under the concurrency limit.
 *  - `running`: a run is executing.
 *  - `awaiting-approval`: the run is parked on at least one user approval.
 *  - `done` / `error`: the last run finished (or failed).
 */
export type SessionStatus = "idle" | "queued" | "running" | "awaiting-approval" | "done" | "error";

/** `shared` edits the workspace checkout; `isolated` works in its own git worktree. */
export type SessionMode = "shared" | "isolated";

/** Cumulative token and cost accounting for every run in the session. */
export interface SessionLedger {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
}

export interface SessionSummary {
  id: string;
  repoKey: string;
  title: string;
  status: SessionStatus;
  model: string;
  mode: SessionMode;
  createdAt: number;
  /** Last create/run/event/touch; drives abandoned-session cleanup. */
  lastActiveAt: number;
  /** The chat thread this session writes to. */
  conversationId: string | null;
  /** The run executing (or queued) now. */
  runId: string | null;
  /** Position in the run queue (1 = next), when `queued`. */
  queuePosition: number | null;
  /** Approvals the current run is waiting on. */
  pendingApprovals: number;
  ledger: SessionLedger;
  /** Files this session currently holds the write lock on. */
  lockedFiles: string[];
  /** Session-scoped checkpoints, newest first (undo targets). */
  checkpointIds: string[];
  /** Isolated sessions: the worktree they run in. */
  worktree?: { path: string; repoKey: string };
  /** Why the last run failed, when `error`. */
  error?: string;
}

/** GET /api/sessions?repoKey= */
export interface SessionListResponse {
  sessions: SessionSummary[];
  config: SessionConfig;
  running: number;
  queued: number;
}

/** Workspace-independent session settings (server-side). */
export interface SessionConfig {
  /** Runs that may execute at once per workspace; more are queued. */
  maxConcurrent: number;
  /** Idle sessions untouched this long are deleted. */
  idleTtlMs: number;
}

/** POST /api/sessions */
export interface CreateSessionRequest {
  repoKey: string;
  title?: string;
  model?: string;
  conversationId?: string;
  mode?: SessionMode;
}
