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
 */

import { getValueRaw, setValueRaw } from "@/lib/store";
import {
  deleteFile,
  fullReindex,
  listFiles,
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
  files: { path: string; source: string }[];
}

export interface CheckpointSummary {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
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

  const summaries = await listCheckpoints(handle.repoKey);
  const next: CheckpointSummary[] = [
    {
      id,
      label,
      createdAt: checkpoint.createdAt,
      fileCount: files.length,
      totalBytes,
    },
    ...summaries,
  ];

  // Evict the oldest beyond the cap, deleting their payloads too.
  const kept = next.slice(0, MAX_CHECKPOINTS);
  for (const dropped of next.slice(MAX_CHECKPOINTS)) {
    await setValueRaw(ITEM_KEY(dropped.id), null);
  }
  await setValueRaw(LIST_KEY(handle.repoKey), kept);

  return kept[0];
}

export async function listCheckpoints(
  repoKey: string,
): Promise<CheckpointSummary[]> {
  return (await getValueRaw<CheckpointSummary[]>(LIST_KEY(repoKey))) ?? [];
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
): Promise<{ restored: number; deleted: number } | null> {
  const checkpoint = await getCheckpoint(id);
  if (!checkpoint || checkpoint.repoKey !== handle.repoKey) return null;

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

export async function deleteCheckpoint(
  repoKey: string,
  id: string,
): Promise<void> {
  await setValueRaw(ITEM_KEY(id), null);
  const summaries = await listCheckpoints(repoKey);
  await setValueRaw(
    LIST_KEY(repoKey),
    summaries.filter((c) => c.id !== id),
  );
}
