/**
 * Cross-session file write locks.
 *
 * Inside one run the orchestrator already gives every parallel step an
 * exclusive set of owned files (`writeScope`). This extends that idea to the
 * workspace: when two sessions run against the same checkout, the first one
 * to write a file holds it until its run ends, and a write from any other
 * session is refused with a tool error naming the holder. The model can then
 * work on something else or report the conflict, instead of two agents
 * silently overwriting each other's edits.
 *
 * Locks are keyed by *scope*: the resolved root of a disk workspace, or the
 * repo key of a store workspace. An isolated session works in its own git
 * worktree, so it has its own scope and never contends with the main one.
 *
 * Claims are synchronous check-and-set, which is atomic on the event loop:
 * two sessions racing for the same file cannot both win.
 */

import path from "node:path";

export interface LockOwner {
  /** Session id, or the run id for a run that has no session. */
  ownerId: string;
  /** Human-readable name for the error message ("Refactor auth"). */
  label: string;
}

export interface FileLock extends LockOwner {
  scope: string;
  path: string;
  since: number;
}

export type ClaimResult = { ok: true } | { ok: false; holder: FileLock };

interface LockTable {
  /** scope → normalized path → lock */
  byScope: Map<string, Map<string, FileLock>>;
}

const KEY = Symbol.for("viberon.sessions.fileLocks");
type GlobalWithLocks = typeof globalThis & { [KEY]?: LockTable };
const host = globalThis as GlobalWithLocks;
const table: LockTable = host[KEY] ?? { byScope: new Map() };
host[KEY] = table;

/** Lock scope for a workspace handle-like value. */
export function lockScope(handle: { repoKey: string; rootPath: string | null }): string {
  return handle.rootPath ? `disk:${path.resolve(handle.rootPath)}` : `store:${handle.repoKey}`;
}

/** Same normalization the tool layer uses for write scopes. */
export function normalizeLockPath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

/**
 * Claim `filePath` for `owner`. Re-claiming a file you already hold is a
 * no-op success; a file held by someone else fails with the holder.
 */
export function claimFile(scope: string, filePath: string, owner: LockOwner): ClaimResult {
  const key = normalizeLockPath(filePath);
  let locks = table.byScope.get(scope);
  if (!locks) {
    locks = new Map();
    table.byScope.set(scope, locks);
  }
  const existing = locks.get(key);
  if (existing && existing.ownerId !== owner.ownerId) return { ok: false, holder: existing };
  if (!existing) {
    locks.set(key, { ...owner, scope, path: key, since: Date.now() });
  }
  return { ok: true };
}

/** Who holds `filePath` in `scope`, if anyone. */
export function lockHolder(scope: string, filePath: string): FileLock | undefined {
  return table.byScope.get(scope)?.get(normalizeLockPath(filePath));
}

/** Release every lock `ownerId` holds, in every scope. Returns how many. */
export function releaseOwner(ownerId: string): number {
  let released = 0;
  for (const [scope, locks] of table.byScope) {
    for (const [file, lock] of locks) {
      if (lock.ownerId !== ownerId) continue;
      locks.delete(file);
      released += 1;
    }
    if (locks.size === 0) table.byScope.delete(scope);
  }
  return released;
}

/** Locks in one scope (or all), for the sessions API and tests. */
export function listLocks(scope?: string): FileLock[] {
  const scopes = scope ? [table.byScope.get(scope)] : [...table.byScope.values()];
  return scopes.flatMap((locks) => (locks ? [...locks.values()] : []));
}

/** The tool error a losing write returns. Names the holder so the model can act on it. */
export function lockConflictMessage(filePath: string, holder: FileLock): string {
  return (
    `Refused: ${normalizeLockPath(filePath)} is locked by another session, "${holder.label}" (${holder.ownerId}), ` +
    `which is editing it right now. Two sessions may not write the same file at once. ` +
    `Do not retry this write: continue with other files, or finish and report that this file ` +
    `must wait until session "${holder.label}" completes.`
  );
}

/** Test helper. */
export function resetFileLocksForTests(): void {
  table.byScope.clear();
}
