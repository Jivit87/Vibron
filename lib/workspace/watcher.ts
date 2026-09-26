/**
 * Filesystem watcher for disk workspaces, feeding the workspace-events SSE.
 *
 * One recursive `fs.watch` per root, shared by every subscriber and closed
 * when the last one leaves. Raw events are coalesced over a short window
 * and classified by a stat at flush time: present → changed, gone → deleted.
 * Ignored directories (node_modules, .git, build output) never surface.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { IGNORED_DIRS } from "@/lib/local-disk-workspace";

export interface FsEvent {
  type: "fs";
  changed: string[];
  deleted: string[];
}

type Listener = (event: FsEvent) => void;

interface Watch {
  watcher: FSWatcher | null;
  listeners: Set<Listener>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const KEY = Symbol.for("viberon.workspace.watchers");
type G = typeof globalThis & { [KEY]?: Map<string, Watch> };
const g = globalThis as G;
const watches: Map<string, Watch> = g[KEY] ?? new Map();
g[KEY] = watches;

const DEBOUNCE_MS = 150;
const MAX_BATCH = 2000;

export function isIgnoredPath(rel: string): boolean {
  return rel.split("/").some((segment) => IGNORED_DIRS.has(segment));
}

async function flush(root: string, w: Watch): Promise<void> {
  w.timer = null;
  const batch = [...w.pending].slice(0, MAX_BATCH);
  w.pending.clear();
  const changed: string[] = [];
  const deleted: string[] = [];
  await Promise.all(
    batch.map(async (rel) => {
      try {
        const info = await stat(path.join(root, rel));
        // Directory events are noise; their files report individually.
        if (info.isFile()) changed.push(rel);
      } catch {
        deleted.push(rel);
      }
    }),
  );
  if (changed.length === 0 && deleted.length === 0) return;
  const event: FsEvent = { type: "fs", changed: changed.sort(), deleted: deleted.sort() };
  for (const listener of w.listeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must not stop the others.
    }
  }
}

/** Subscribe to coalesced changes under `rootPath`. Returns an unsubscribe. */
export function watchWorkspace(rootPath: string, listener: Listener): () => void {
  const root = path.resolve(rootPath);
  let w = watches.get(root);
  if (!w) {
    const created: Watch = { watcher: null, listeners: new Set(), pending: new Set(), timer: null };
    try {
      created.watcher = watch(root, { recursive: true, persistent: false }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");
        if (isIgnoredPath(rel)) return;
        created.pending.add(rel);
        if (!created.timer) {
          created.timer = setTimeout(() => void flush(root, created), DEBOUNCE_MS);
        }
      });
      created.watcher.on("error", () => {
        created.watcher?.close();
        created.watcher = null;
      });
    } catch {
      // Recursive watch unsupported or root gone: subscribers just get nothing.
      created.watcher = null;
    }
    w = created;
    watches.set(root, w);
  }
  const entry = w;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher?.close();
      watches.delete(root);
    }
  };
}
