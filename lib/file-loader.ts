/**
 * File-loading service used by the editor and file tree.
 *
 * Why this exists: opening a tab kicks off a `/api/repos/files/<key>?path=...`
 * fetch and writes the result back into the Zustand store via
 * `updateTabSource`. Without coordination, two callers (graph click + cursor
 * sync, or rapid clicks on neighbouring nodes) race — sometimes the spinner
 * never resolves because a stale `null` write lands after the real source.
 *
 * `loadFile` de-dupes by path: if a fetch for that path is already in flight,
 * subsequent callers get the same promise and the store is updated once.
 */

import { useViberon } from "@/store/viberon";

type Pending = { promise: Promise<string | null>; controller: AbortController };

const inflight = new Map<string, Pending>();

/**
 * Open `filePath` as a tab if it isn't already, then load its source. Returns
 * the resolved source string, or `null` on failure.
 *
 * Behavior:
 *   - If the tab is already open with a non-null source → no-op, returns the
 *     cached source.
 *   - If the tab is loading → reuses the in-flight promise.
 *   - Otherwise → opens the tab with a `null` source (spinner) and starts a
 *     fetch.
 */
export async function loadFile(
  repoKey: string,
  filePath: string,
  opts: { activate?: boolean } = {},
): Promise<string | null> {
  const store = useViberon.getState();
  const existingTab = store.tabs.find((t) => t.path === filePath);
  const existingSource = existingTab?.source;

  // Already cached → just activate.
  if (existingTab && typeof existingSource === "string") {
    if (opts.activate !== false) {
      store.activateTab(filePath);
    }
    return existingSource;
  }

  // Open the tab so the UI shows a spinner immediately. `openTab` activates
  // by default, which we want unless the caller asked otherwise.
  if (opts.activate !== false) {
    store.openTab(filePath, null);
  } else if (!existingTab) {
    // Pre-create the tab without activating so the spinner is ready when the
    // user does click it.
    store.openTab(filePath, null);
    // Switch back to whatever was active before (openTab activates new tabs).
    if (store.activeTabPath && store.activeTabPath !== filePath) {
      store.activateTab(store.activeTabPath);
    }
  }

  const cached = inflight.get(filePath);
  if (cached) {
    return cached.promise;
  }

  const controller = new AbortController();
  const promise = (async () => {
    try {
      const res = await fetch(
        `/api/repos/files/${repoKey}?path=${encodeURIComponent(filePath)}`,
        { signal: controller.signal },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message =
          (body && typeof body.error === "string" && body.error) ||
          `Failed to load (HTTP ${res.status})`;
        useViberon
          .getState()
          .updateTabSource(
            filePath,
            `// ${message}\n//\n// This file isn't cached. Re-ingest the repo from the home page to refresh raw sources.`,
          );
        return null;
      }
      const body = (await res.json()) as { source: string };
      useViberon.getState().updateTabSource(filePath, body.source);
      return body.source;
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return null;
      useViberon
        .getState()
        .updateTabSource(filePath, "// network error loading file");
      return null;
    } finally {
      inflight.delete(filePath);
    }
  })();

  inflight.set(filePath, { promise, controller });
  return promise;
}

/** Cancel an in-flight load for a path. Useful when closing a tab. */
export function cancelLoad(filePath: string): void {
  const pending = inflight.get(filePath);
  if (!pending) return;
  pending.controller.abort();
  inflight.delete(filePath);
}

/**
 * Persist edits to a file. Updates the in-memory tab immediately so the
 * editor stays responsive, then PUTs the new source to the server (which
 * writes to `rawFiles` only — disk is untouched).
 *
 * Debounce-safe: callers can call this on every keystroke; the network
 * trips are coalesced via the per-path inflight map so the latest write
 * wins.
 */
export async function saveFile(
  repoKey: string,
  filePath: string,
  source: string,
): Promise<boolean> {
  // Update the in-memory tab right away so the UI is responsive, even if
  // the network is slow.
  useViberon.getState().updateTabSource(filePath, source);

  const key = `save:${filePath}`;
  // Cancel any pending save for this file so only the latest body is posted.
  const existing = inflight.get(key);
  if (existing) {
    existing.controller.abort();
    inflight.delete(key);
  }

  const controller = new AbortController();
  const promise = (async () => {
    try {
      const res = await fetch(
        `/api/repos/files/${repoKey}?path=${encodeURIComponent(filePath)}`,
        {
          method: "PUT",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source }),
        },
      );
      if (!res.ok) {
        // Don't blow away the local edit on save failure — the user can keep
        // typing and we'll retry on the next save.
        return null;
      }
      return source;
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return null;
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, { promise, controller });
  const result = await promise;
  return result !== null;
}
