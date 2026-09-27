/**
 * Workspace checkpoints.
 *
 * An agent run can touch twenty files. Undoing that one diff at a time is
 * not a real recovery story, so before every run the workspace is snapshotted
 * and the user gets a single "restore" button.
 *
 * Snapshots store full file contents. That is fine at the scale this tool
 * targets (a project, not a monorepo) and is far simpler — and more reliable
 * to restore — than a delta chain.
 *
 * With several sessions editing one checkout, a whole-workspace restore
 * would also revert the *other* sessions' work. So a run that belongs to a
 * session gets a **session-scoped** checkpoint instead: an empty journal
 * that records, for each file the session writes, its content before the
 * session first touched it and after the session last touched it. Restoring
 * it reverts exactly those files, and refuses (as a conflict) any file that
 * someone else has changed since, or that another session holds locked.
 */

import { withKeyedLock } from "@/lib/concurrency/keyed-mutex";
import { lockHolder, lockScope } from "@/lib/sessions/file-locks";
import { getValueRaw, setValueRaw } from "@/lib/store";
import {
  deleteFile,
  fullReindex,
  listFiles,
  readFile,
  writeFile,
  type WorkspaceHandle,
} from "@/lib/workspace";

export interface Checkpoint {
  id: string;
  repoKey: string;
  label: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  /** Workspace scope: every file. Session scope: pre-images of files that existed. */
  files: { path: string; source: string }[];
  /** "workspace" (the default) snapshots everything; "session" journals one session's writes. */
  scope?: "workspace" | "session";
  sessionId?: string;
  /** Session scope: files the session created (restore deletes them). */
  created?: string[];
  /** Session scope: each journaled file's content after the session's last write (null = deleted). */
  latest?: Record<string, string | null>;
}

export interface CheckpointSummary {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
  scope?: "workspace" | "session";
  sessionId?: string;
}

/** One file-change event, as the tools report it. */
export interface JournalChange {
  kind: "create" | "update" | "delete" | "rename";
  path: string;
  previousPath?: string;
  before: string | null;
  after: string | null;
}

export interface RestoreResult {
  restored: number;
  deleted: number;
  /** Session scope: files left alone, and why. */
  conflicts?: { path: string; reason: string }[];
}

const LIST_KEY = (repoKey: string) => `checkpoints:${repoKey}`;
const ITEM_KEY = (id: string) => `checkpoint:${id}`;

/** Keep the last N; snapshots are the largest thing in the store. */
const MAX_CHECKPOINTS = 12;
/** Refuse to snapshot a workspace larger than this — it would not be useful. */
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

export async function createCheckpoint(
  handle: WorkspaceHandle,
  label: string,
): Promise<CheckpointSummary | null> {
  const files = await listFiles(handle);
  const totalBytes = files.reduce((sum, f) => sum + f.source.length, 0);
  if (totalBytes > MAX_SNAPSHOT_BYTES) return null;

  const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const checkpoint: Checkpoint = {
    id,
    repoKey: handle.repoKey,
    label,
    createdAt: Date.now(),
    fileCount: files.length,
    totalBytes,
    files: files.map((f) => ({ path: f.path, source: f.source })),
  };

  await setValueRaw(ITEM_KEY(id), checkpoint);
  return addSummary(handle.repoKey, {
    id,
    label,
    createdAt: checkpoint.createdAt,
    fileCount: files.length,
    totalBytes,
  });
}

/** Prepend a summary and evict the oldest beyond the cap, deleting their payloads too. */
function addSummary(repoKey: string, summary: CheckpointSummary): Promise<CheckpointSummary> {
  return withKeyedLock("checkpoint-list", repoKey, async () => {
    const next = [summary, ...(await listCheckpoints(repoKey))];
    const kept = next.slice(0, MAX_CHECKPOINTS);
    for (const dropped of next.slice(MAX_CHECKPOINTS)) {
      await setValueRaw(ITEM_KEY(dropped.id), null);
    }
    await setValueRaw(LIST_KEY(repoKey), kept);
    return kept[0];
  });
}

/**
 * Start a session-scoped checkpoint: an empty journal that fills as the
 * session writes files (`journalFileChange`). Costs nothing up front, unlike
 * a full snapshot, and restoring it touches only the session's own files.
 */
export async function createSessionCheckpoint(
  handle: WorkspaceHandle,
  sessionId: string,
  label: string,
): Promise<CheckpointSummary> {
  const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const checkpoint: Checkpoint = {
    id,
    repoKey: handle.repoKey,
    label,
    createdAt: Date.now(),
    fileCount: 0,
    totalBytes: 0,
    files: [],
    scope: "session",
    sessionId,
    created: [],
    latest: {},
  };
  await setValueRaw(ITEM_KEY(id), checkpoint);
  return addSummary(handle.repoKey, {
    id,
    label,
    createdAt: checkpoint.createdAt,
    fileCount: 0,
    totalBytes: 0,
    scope: "session",
    sessionId,
  });
}

/**
 * Record one file change in a session checkpoint. The first time a path is
 * seen its pre-image is kept (or it is marked created); every time, its
 * latest content is updated. Serialized per checkpoint, so concurrent agents
 * in one run cannot lose each other's entries.
 */
export function journalFileChange(checkpointId: string, change: JournalChange): Promise<void> {
  return withKeyedLock("checkpoint", checkpointId, async () => {
    const checkpoint = await getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.scope !== "session") return;
    const created = new Set(checkpoint.created ?? []);
    const latest = { ...(checkpoint.latest ?? {}) };
    const files = [...checkpoint.files];
    const remember = (p: string, before: string | null) => {
      if (p in latest) return;
      if (before === null) created.add(p);
      else files.push({ path: p, source: before });
    };

    if (change.kind === "rename" && change.previousPath) {
      remember(change.previousPath, change.before);
      latest[change.previousPath] = null;
      // A rename target is a new file unless the session had already written it.
      remember(change.path, null);
      latest[change.path] = change.after;
    } else {
      remember(change.path, change.before);
      latest[change.path] = change.kind === "delete" ? null : change.after;
    }

    const next: Checkpoint = {
      ...checkpoint,
      files,
      created: [...created],
      latest,
      fileCount: Object.keys(latest).length,
      totalBytes: files.reduce((sum, f) => sum + f.source.length, 0),
    };
    await setValueRaw(ITEM_KEY(checkpointId), next);
    await withKeyedLock("checkpoint-list", next.repoKey, async () => {
      const summaries = await listCheckpoints(next.repoKey);
      await setValueRaw(
        LIST_KEY(next.repoKey),
        summaries.map((s) =>
          s.id === checkpointId ? { ...s, fileCount: next.fileCount, totalBytes: next.totalBytes } : s,
        ),
      );
    });
  });
}

export async function listCheckpoints(
  repoKey: string,
  filter: { sessionId?: string } = {},
): Promise<CheckpointSummary[]> {
  const all = (await getValueRaw<CheckpointSummary[]>(LIST_KEY(repoKey))) ?? [];
  return filter.sessionId ? all.filter((c) => c.sessionId === filter.sessionId) : all;
}

export async function getCheckpoint(id: string): Promise<Checkpoint | null> {
  return getValueRaw<Checkpoint>(ITEM_KEY(id));
}

/**
 * Restore a snapshot: rewrite every file it contains, and delete anything
 * created since. Returns what changed so the UI can report it precisely.
 */
export async function restoreCheckpoint(
  handle: WorkspaceHandle,
  id: string,
  options: { force?: boolean } = {},
): Promise<RestoreResult | null> {
  const checkpoint = await getCheckpoint(id);
  if (!checkpoint || checkpoint.repoKey !== handle.repoKey) return null;
  if (checkpoint.scope === "session") return restoreSessionCheckpoint(handle, checkpoint, options);

  const snapshotPaths = new Set(checkpoint.files.map((f) => f.path));
  const current = await listFiles(handle);

  let restored = 0;
  for (const file of checkpoint.files) {
    const existing = current.find((f) => f.path === file.path);
    if (existing?.source === file.source) continue;
    await writeFile(handle, file.path, file.source);
    restored += 1;
  }

  let deleted = 0;
  for (const file of current) {
    if (snapshotPaths.has(file.path)) continue;
    if (await deleteFile(handle, file.path)) deleted += 1;
  }

  await fullReindex(handle);
  return { restored, deleted };
}

/**
 * Undo one session's writes and nothing else. A file whose current content
 * is not what the session last wrote was changed by someone else since
 * (another session, the user, a formatter): it is reported as a conflict
 * and left alone unless `force`. A file another session holds the write
 * lock on is never touched, force or not.
 */
async function restoreSessionCheckpoint(
  handle: WorkspaceHandle,
  checkpoint: Checkpoint,
  options: { force?: boolean },
): Promise<RestoreResult> {
  return withKeyedLock("checkpoint", checkpoint.id, async () => {
    const fresh = (await getCheckpoint(checkpoint.id)) ?? checkpoint;
    const latest = { ...(fresh.latest ?? {}) };
    const preimages = new Map(fresh.files.map((f) => [f.path, f.source] as const));
    const created = new Set(fresh.created ?? []);
    const scope = lockScope(handle);
    const conflicts: { path: string; reason: string }[] = [];
    let restored = 0;
    let deleted = 0;

    for (const path of Object.keys(latest).sort()) {
      const holder = lockHolder(scope, path);
      if (holder && holder.ownerId !== fresh.sessionId) {
        conflicts.push({ path, reason: `locked by session "${holder.label}"` });
        continue;
      }
      const current = await readFile(handle, path);
      if (!options.force && current !== latest[path]) {
        conflicts.push({ path, reason: "changed since this session wrote it" });
        continue;
      }
      if (created.has(path) && !preimages.has(path)) {
        if (current !== null && (await deleteFile(handle, path))) deleted += 1;
        latest[path] = null;
        continue;
      }
      const source = preimages.get(path);
      if (source === undefined) continue;
      if (current !== source) {
        await writeFile(handle, path, source);
        restored += 1;
      }
      latest[path] = source;
    }

    // What the session "last wrote" is now the pre-image, so a second
    // restore is a no-op rather than a wall of conflicts.
    await setValueRaw(ITEM_KEY(fresh.id), { ...fresh, latest });
    return { restored, deleted, conflicts };
  });
}

export async function deleteCheckpoint(
  repoKey: string,
  id: string,
): Promise<void> {
  await setValueRaw(ITEM_KEY(id), null);
  await withKeyedLock("checkpoint-list", repoKey, async () => {
    const summaries = await listCheckpoints(repoKey);
    await setValueRaw(
      LIST_KEY(repoKey),
      summaries.filter((c) => c.id !== id),
    );
  });
}
