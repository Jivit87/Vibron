/**
 * Persistent, incremental code graph.
 *
 * The expensive part of building the graph is parsing; the cheap part is
 * linking. We cache one `FileExtract` per source file, keyed by content
 * hash, in `<root>/.viberon/graph.json` (disk workspaces) or in-process
 * (store workspaces). Opening a workspace re-parses only files whose hash
 * changed; a write re-parses exactly that one file. Both then re-link.
 *
 * `.viberon/` is added to `.git/info/exclude` so the cache never enters a diff.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Graph } from "@/lib/graph";
import type { RepoFile } from "@/lib/github";
import { isSourceFilePath } from "@/lib/github";
import { loadPathAliases, type PathAliases } from "@/lib/lang/tsconfig";
import { extractFile, goModuleOf, hashSource, linkGraph, type FileExtract } from "@/lib/parser";

export const GRAPH_INDEX_VERSION = 1;
export const VIBERON_DIR = ".viberon";

export interface GraphIndexDoc {
  version: number;
  repoRef: string;
  aliases: PathAliases[];
  goModule: string | null;
  files: Record<string, FileExtract>;
}

export interface IndexStats {
  parsed: number;
  reused: number;
  removed: number;
}

const memoryIndexes = ((globalThis as { __viberonGraphIndexes?: Map<string, GraphIndexDoc> })
  .__viberonGraphIndexes ??= new Map<string, GraphIndexDoc>());

/**
 * Bug fix (High #5 — Graph Race Condition):
 * Per-workspace serialisation lock.  `patchIndexedFile` and
 * `indexWorkspaceFiles` both follow a read→modify→write pattern on the same
 * `graph.json` file.  Without a lock, two concurrent edits (e.g. two
 * agents writing different files at the same millisecond) both read the
 * same stale snapshot, update independent keys, and the second flush
 * silently overwrites the first's changes.
 *
 * We use a simple Promise-chaining mutex (no extra dependency): each
 * workspace gets a chain of Promises; each new writer appends to the tail
 * and awaits the previous writer's completion before starting its own work.
 */
const graphWriteLocks = ((globalThis as { __viberonGraphWriteLocks?: Map<string, Promise<unknown>> })
  .__viberonGraphWriteLocks ??= new Map<string, Promise<unknown>>());

function withGraphLock<T>(key: string, rootPath: string | null, fn: () => Promise<T>): Promise<T> {
  const lockKey = cacheKey(key, rootPath);
  const previous = graphWriteLocks.get(lockKey) ?? Promise.resolve();
  const next = previous.then(fn, fn); // always advance the chain, even on error
  graphWriteLocks.set(lockKey, next);
  return next as Promise<T>;
}

function indexPath(rootPath: string): string {
  return path.join(rootPath, VIBERON_DIR, "graph.json");
}

function cacheKey(key: string, rootPath: string | null): string {
  return rootPath ? `disk:${path.resolve(rootPath)}` : `store:${key}`;
}

/** Synchronous read of the persisted index (memory helpers need it without awaiting). */
export function loadGraphIndexSync(rootPath: string): GraphIndexDoc | null {
  const cached = memoryIndexes.get(cacheKey("", rootPath));
  if (cached) return cached;
  try {
    const file = indexPath(rootPath);
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8")) as GraphIndexDoc;
    if (doc.version !== GRAPH_INDEX_VERSION) return null;
    memoryIndexes.set(cacheKey("", rootPath), doc);
    return doc;
  } catch {
    return null;
  }
}

async function loadIndex(key: string, rootPath: string | null): Promise<GraphIndexDoc | null> {
  const cached = memoryIndexes.get(cacheKey(key, rootPath));
  if (cached) return cached;
  if (!rootPath) return null;
  try {
    const doc = JSON.parse(await readFile(indexPath(rootPath), "utf8")) as GraphIndexDoc;
    if (doc.version !== GRAPH_INDEX_VERSION) return null;
    memoryIndexes.set(cacheKey(key, rootPath), doc);
    return doc;
  } catch {
    return null;
  }
}

async function saveIndex(key: string, rootPath: string | null, doc: GraphIndexDoc): Promise<void> {
  memoryIndexes.set(cacheKey(key, rootPath), doc);
  if (!rootPath) return;
  try {
    await ensureViberonDir(rootPath);
    const target = indexPath(rootPath);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, target);
  } catch {
    // Read-only workspace: the in-process cache still makes writes incremental.
  }
}

/** Create `.viberon/` and keep it out of git (`.git/info/exclude`). */
export async function ensureViberonDir(rootPath: string): Promise<string> {
  const dir = path.join(rootPath, VIBERON_DIR);
  await mkdir(dir, { recursive: true });
  await excludeFromGit(rootPath, `/${VIBERON_DIR}/`);
  return dir;
}

/** Append a pattern to `.git/info/exclude` once. No-op outside git repos. */
export async function excludeFromGit(rootPath: string, pattern: string): Promise<boolean> {
  const gitDir = path.join(rootPath, ".git");
  let infoDir: string;
  try {
    const info = await stat(gitDir);
    if (info.isDirectory()) infoDir = path.join(gitDir, "info");
    else {
      // Worktree: `.git` is a file pointing at the real git dir.
      const pointer = (await readFile(gitDir, "utf8")).match(/gitdir:\s*(.+)/)?.[1]?.trim();
      if (!pointer) return false;
      const resolved = path.resolve(rootPath, pointer);
      const common = await readFile(path.join(resolved, "commondir"), "utf8").catch(() => null);
      infoDir = path.join(common ? path.resolve(resolved, common.trim()) : resolved, "info");
    }
  } catch {
    return false;
  }
  const file = path.join(infoDir, "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;
  await mkdir(infoDir, { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  return true;
}

function linkDoc(doc: GraphIndexDoc): Graph {
  return linkGraph(Object.values(doc.files), {
    repoRef: doc.repoRef,
    knownFiles: new Set(Object.keys(doc.files)),
    aliases: doc.aliases,
    goModule: doc.goModule,
  });
}

/**
 * Bring the index in line with `files` (the full workspace listing): reuse
 * extracts whose hash matches, parse the rest, drop deleted files, re-link.
 */
export async function indexWorkspaceFiles(
  key: string,
  rootPath: string | null,
  repoRef: string,
  files: RepoFile[],
): Promise<{ graph: Graph; stats: IndexStats }> {
  return withGraphLock(key, rootPath, async () => {
    const previous = await loadIndex(key, rootPath);
    const doc: GraphIndexDoc = {
      version: GRAPH_INDEX_VERSION,
      repoRef,
      aliases: loadPathAliases(files),
      goModule: goModuleOf(files),
      files: {},
    };
    const stats: IndexStats = { parsed: 0, reused: 0, removed: 0 };
    for (const file of files) {
      if (!isSourceFilePath(file.path)) continue;
      const hash = hashSource(file.source);
      const cached = previous?.files[file.path];
      if (cached && cached.hash === hash) {
        doc.files[file.path] = cached;
        stats.reused += 1;
      } else {
        doc.files[file.path] = extractFile(file);
        stats.parsed += 1;
      }
    }
    if (previous) {
      stats.removed = Object.keys(previous.files).filter((p) => !(p in doc.files)).length;
    }
    await saveIndex(key, rootPath, doc);
    return { graph: linkDoc(doc), stats };
  });
}

/**
 * Patch the index for one written (or deleted, `source === null`) file.
 * Returns null when there is no index yet or the change affects resolution
 * config (tsconfig/go.mod) — the caller then does a full (still cached) index.
 */
export async function patchIndexedFile(
  key: string,
  rootPath: string | null,
  filePath: string,
  source: string | null,
): Promise<Graph | null> {
  if (/(^|\/)(tsconfig[^/]*|jsconfig[^/]*)\.json$|^go\.mod$/.test(filePath)) return null;
  return withGraphLock(key, rootPath, async () => {
    const current = await loadIndex(key, rootPath);
    if (!current) return null;
    if (source === null ? !(filePath in current.files) : !isSourceFilePath(filePath)) {
      return linkDoc(current);
    }
    if (source !== null && current.files[filePath]?.hash === hashSource(source)) return linkDoc(current);
    // New doc object (not an in-place edit) so readers' per-doc caches invalidate.
    const doc: GraphIndexDoc = { ...current, files: { ...current.files } };
    if (source === null) delete doc.files[filePath];
    else doc.files[filePath] = extractFile({ path: filePath, source });
    await saveIndex(key, rootPath, doc);
    return linkDoc(doc);
  });
}

/** Current graph from the cached index without touching any file. */
export async function graphFromIndex(key: string, rootPath: string | null): Promise<Graph | null> {
  const doc = await loadIndex(key, rootPath);
  return doc ? linkDoc(doc) : null;
}

/** Forget cached indexes (tests). */
export function clearGraphIndexCache(): void {
  memoryIndexes.clear();
}
