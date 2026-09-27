/**
 * Unified workspace filesystem.
 *
 * Two backends behind one interface:
 *  - **Disk workspace** — a real folder the user opened. Writes hit the
 *    filesystem, so `npm run dev` in the integrated terminal sees them.
 *  - **Store workspace** — an in-memory/ingested repo with no folder on
 *    disk. Writes land in the app store instead.
 *
 * Every mutation goes through here so three things stay in lockstep:
 * the file contents, the symbol graph, and project memory. The graph is
 * patched **incrementally** — re-parsing one file instead of the whole repo
 * is the difference between an edit costing 5ms and 3s on a large project.
 */

import path from "node:path";

import { withKeyedLock } from "@/lib/concurrency/keyed-mutex";
import type { Graph, StoredRawFile } from "@/lib/graph";
import {
  getLocalWorkspace,
  getGraph,
  getRawFiles,
  putFileInfo,
  putGraph,
  putRawFiles,
} from "@/lib/store";
import {
  patchWorkspaceFile,
  readLocalWorkspaceFile,
  resolveWorkspaceFilePath,
  scanLocalWorkspace,
  WorkspacePathError,
  writeLocalWorkspaceFile,
} from "@/lib/local-disk-workspace";
import { indexWorkspaceFiles } from "@/lib/workspace/graph-index";
import { countTokens } from "@/lib/tokens";
import {
  deriveMemory,
  importLegacyEntries,
  loadMemory,
  mergeMemory,
  saveMemory,
  withMemoryLock,
} from "@/lib/memory";
import type { ProjectMemory } from "@/lib/memory/types";
import { LspManager } from "@/lib/lsp";

export interface WorkspaceHandle {
  repoKey: string;
  /** Absolute path when disk-backed, else null. */
  rootPath: string | null;
  repoRef: string;
  label: string;
  /** LSP manager for real-time compiler diagnostics (if workspace has rootPath). */
  lsp?: LspManager;
}

export async function openWorkspace(repoKey: string): Promise<WorkspaceHandle> {
  const meta = await getLocalWorkspace(repoKey);
  if (meta) {
    return {
      repoKey,
      rootPath: meta.rootPath,
      repoRef: meta.repoRef,
      label: meta.label,
      lsp: meta.rootPath ? new LspManager(meta.rootPath) : undefined,
    };
  }
  const graph = await getGraph(repoKey);
  return {
    repoKey,
    rootPath: null,
    repoRef: graph?.meta.repoRef ?? `store/${repoKey}`,
    label: graph?.meta.repoRef?.split("/")[1]?.split("@")[0] ?? "Workspace",
    lsp: undefined,
  };
}

/**
 * Clean up workspace resources (LSP servers, etc.).
 * Call this when done with a workspace to prevent resource leaks.
 */
export async function closeWorkspace(handle: WorkspaceHandle): Promise<void> {
  if (handle.lsp) {
    await handle.lsp.shutdown();
  }
}

/* ------------------------------ reads ------------------------------------ */

export async function listFiles(handle: WorkspaceHandle): Promise<StoredRawFile[]> {
  if (handle.rootPath) return scanLocalWorkspace(handle.rootPath);
  return getRawFiles(handle.repoKey);
}

export async function readFile(
  handle: WorkspaceHandle,
  filePath: string,
): Promise<string | null> {
  if (handle.rootPath) {
    const file = await readLocalWorkspaceFile(handle.repoKey, filePath);
    return file?.source ?? null;
  }
  const all = await getRawFiles(handle.repoKey);
  return all.find((f) => f.path === filePath)?.source ?? null;
}

export async function fileExists(
  handle: WorkspaceHandle,
  filePath: string,
): Promise<boolean> {
  return (await readFile(handle, filePath)) !== null;
}

/* ----------------------------- mutations --------------------------------- */

export interface WriteResult {
  path: string;
  created: boolean;
  bytes: number;
}

export async function writeFile(
  handle: WorkspaceHandle,
  filePath: string,
  source: string,
): Promise<WriteResult> {
  const existed = await fileExists(handle, filePath);

  if (handle.rootPath) {
    // Throws WorkspacePathError on traversal attempts — never write outside.
    resolveWorkspaceFilePath(handle.rootPath, filePath);
    // Writes the file and patches graph/raw/token index for it alone.
    await writeLocalWorkspaceFile(handle.repoKey, filePath, source);
  } else {
    await patchGraphForFile(handle, filePath, source);
  }
  return { path: filePath, created: !existed, bytes: source.length };
}

export async function deleteFile(
  handle: WorkspaceHandle,
  filePath: string,
): Promise<boolean> {
  if (handle.rootPath) {
    const absolute = resolveWorkspaceFilePath(handle.rootPath, filePath);
    const { rm } = await import("node:fs/promises");
    try {
      await rm(absolute, { recursive: false, force: false });
    } catch {
      return false;
    }
  } else {
    // Same lock as `patchWorkspaceFile`: the raw list is shared by sessions.
    const removed = await withKeyedLock("workspace-files", handle.repoKey, async () => {
      const all = await getRawFiles(handle.repoKey);
      const next = all.filter((f) => f.path !== filePath);
      if (next.length === all.length) return false;
      await putRawFiles(handle.repoKey, next);
      return true;
    });
    if (!removed) return false;
  }
  await patchGraphForFile(handle, filePath, null);
  return true;
}

export async function renameFile(
  handle: WorkspaceHandle,
  from: string,
  to: string,
): Promise<boolean> {
  const source = await readFile(handle, from);
  if (source === null) return false;
  await writeFile(handle, to, source);
  await deleteFile(handle, from);
  return true;
}

export async function createDirectory(
  handle: WorkspaceHandle,
  dirPath: string,
): Promise<boolean> {
  if (!handle.rootPath) {
    // Store workspaces have no real directories; paths are implicit.
    return true;
  }
  const absolute = resolveWorkspaceFilePath(handle.rootPath, dirPath);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(absolute, { recursive: true });
  return true;
}

/* -------------------------- incremental graph ---------------------------- */

/**
 * Patch the graph for a single changed file: re-extract that file only and
 * re-link from the per-file cache (see `graph-index.ts`). No directory scan,
 * no whole-repo parse, and cross-file edges into the file stay correct.
 */
async function patchGraphForFile(
  handle: WorkspaceHandle,
  filePath: string,
  source: string | null,
): Promise<void> {
  await patchWorkspaceFile(handle.repoKey, handle.rootPath, handle.repoRef, filePath, source);
}

/**
 * Full re-index + memory re-derive. Used on open and after bulk changes.
 * Only files whose content hash changed are re-parsed.
 */
export async function fullReindex(
  handle: WorkspaceHandle,
): Promise<{ graph: Graph; memory: ProjectMemory }> {
  const files = await listFiles(handle);
  const { graph } = await indexWorkspaceFiles(handle.repoKey, handle.rootPath, handle.repoRef, files);
  const parsed = { graph };

  await Promise.all([
    putGraph(handle.repoKey, parsed.graph),
    putFileInfo(
      handle.repoKey,
      files.map((f) => ({ path: f.path, tokenCount: countTokens(f.source) })),
    ),
    handle.rootPath ? Promise.resolve() : putRawFiles(handle.repoKey, files),
  ]);

  const memory = await withMemoryLock(handle.repoKey, async () => {
    const loaded = await loadMemory(handle.repoKey);
    deriveMemory(loaded, files, parsed.graph);
    if (handle.rootPath) importLegacyEntries(handle.rootPath, loaded);
    await saveMemory(loaded);
    return loaded;
  });

  return { graph: parsed.graph, memory };
}

/**
 * Refresh derived memory without a full graph re-parse. Cheap enough to run
 * at the end of every agent turn.
 *
 * `pending` is a run's working copy and the base it loaded: its learned
 * entries are merged in first (`mergeMemory`), so re-deriving between waves
 * neither drops what the run recorded nor overwrites what a concurrent
 * session saved. The read-derive-save runs under the memory lock.
 */
export async function refreshMemory(
  handle: WorkspaceHandle,
  pending?: { base: ProjectMemory; local: ProjectMemory },
): Promise<ProjectMemory> {
  const [files, graph] = await Promise.all([listFiles(handle), getGraph(handle.repoKey)]);
  return withMemoryLock(handle.repoKey, async () => {
    const stored = await loadMemory(handle.repoKey);
    const memory = pending ? mergeMemory(stored, pending.base, pending.local) : stored;
    deriveMemory(memory, files, graph);
    await saveMemory(memory);
    return memory;
  });
}

/** Mirror memory to `.viberon/MEMORY.md` so humans can read it too. */
export async function writeMemoryMirror(
  handle: WorkspaceHandle,
  markdown: string,
): Promise<void> {
  if (!handle.rootPath) return;
  const { mkdir, writeFile: fsWriteFile } = await import("node:fs/promises");
  const dir = path.join(handle.rootPath, ".viberon");
  try {
    await mkdir(dir, { recursive: true });
    await fsWriteFile(path.join(dir, "MEMORY.md"), markdown, "utf8");
  } catch {
    // Non-fatal: a read-only workspace still gets memory via the store.
  }
}

export { WorkspacePathError };
