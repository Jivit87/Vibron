/**
 * Pure tab-strip state transitions for the editor.
 *
 * Kept free of React and Zustand so every rule VS Code users rely on —
 * preview tabs, where a new tab lands, which tab activates after a close —
 * is unit-testable. The store delegates to these; the UI never reimplements
 * them.
 *
 * Vocabulary:
 *  - **preview tab**: opened by a single click in the explorer. Rendered in
 *    italics, and replaced by the next preview open. It becomes a normal
 *    ("pinned") tab once edited or double-clicked.
 */

export interface TabLike {
  path: string;
  label: string;
  source?: string | null;
  dirty?: boolean;
  preview?: boolean;
}

export interface TabsState<T extends TabLike = TabLike> {
  tabs: T[];
  activeTabPath: string | null;
}

export interface OpenTabOptions {
  /** Open as a preview tab (replaces any existing clean preview tab). */
  preview?: boolean;
  /** Activate the tab. Default true. */
  activate?: boolean;
}

/**
 * Open (or focus) a tab.
 *
 *  - An already-open tab is focused; opening it non-preview pins it, and a
 *    provided `source` replaces its buffer (clearing `dirty`).
 *  - A new preview tab takes over the slot of the current preview tab, as
 *    long as that one has no unsaved edits.
 *  - Otherwise the new tab lands immediately right of the active tab.
 */
export function openTabState<T extends TabLike>(
  state: TabsState<T>,
  tab: T,
  options: OpenTabOptions = {},
): TabsState<T> {
  const activate = options.activate !== false;
  const preview = Boolean(options.preview);
  const existingIndex = state.tabs.findIndex((t) => t.path === tab.path);

  if (existingIndex !== -1) {
    const existing = state.tabs[existingIndex];
    const next: T = {
      ...existing,
      ...(tab.source !== undefined ? { source: tab.source, dirty: false } : {}),
      // Re-opening non-preview pins; re-opening as preview never un-pins.
      preview: preview ? existing.preview : false,
    };
    const tabs = state.tabs.slice();
    tabs[existingIndex] = next;
    return { tabs, activeTabPath: activate ? tab.path : state.activeTabPath };
  }

  const fresh: T = { ...tab, preview: preview || undefined };
  if (!fresh.preview) delete fresh.preview;

  const tabs = state.tabs.slice();
  if (preview) {
    const previewIndex = tabs.findIndex((t) => t.preview && !t.dirty);
    if (previewIndex !== -1) {
      tabs[previewIndex] = fresh;
      return { tabs, activeTabPath: activate ? fresh.path : state.activeTabPath };
    }
  }

  const activeIndex = tabs.findIndex((t) => t.path === state.activeTabPath);
  const insertAt = activeIndex === -1 ? tabs.length : activeIndex + 1;
  tabs.splice(insertAt, 0, fresh);
  return { tabs, activeTabPath: activate ? fresh.path : state.activeTabPath };
}

/** Turn a preview tab into a normal one. No-op if already pinned. */
export function pinTabState<T extends TabLike>(
  state: TabsState<T>,
  path: string,
): TabsState<T> {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab?.preview) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.path === path ? { ...t, preview: false } : t)),
  };
}

/**
 * Close a set of tabs. When the active tab closes, focus moves to the
 * nearest surviving tab on its left (or right, if it was leftmost). The
 * strip never ends empty — `fallback` is inserted if everything closed.
 */
export function closeTabsState<T extends TabLike>(
  state: TabsState<T>,
  paths: Iterable<string>,
  fallback: T,
): TabsState<T> {
  const closing = new Set(paths);
  if (closing.size === 0) return state;
  const tabs = state.tabs.filter((t) => !closing.has(t.path));
  if (tabs.length === state.tabs.length) return state;
  if (tabs.length === 0) return { tabs: [fallback], activeTabPath: fallback.path };

  if (state.activeTabPath && !closing.has(state.activeTabPath)) {
    return { tabs, activeTabPath: state.activeTabPath };
  }

  const activeIndex = state.tabs.findIndex((t) => t.path === state.activeTabPath);
  // Walk left from the closed active tab for the nearest survivor, then right.
  for (let i = activeIndex - 1; i >= 0; i -= 1) {
    if (!closing.has(state.tabs[i].path)) {
      return { tabs, activeTabPath: state.tabs[i].path };
    }
  }
  for (let i = activeIndex + 1; i < state.tabs.length; i += 1) {
    if (!closing.has(state.tabs[i].path)) {
      return { tabs, activeTabPath: state.tabs[i].path };
    }
  }
  return { tabs, activeTabPath: tabs[0].path };
}

/** Paths closed by "Close Others" on `path`. */
export function othersOf(tabs: TabLike[], path: string): string[] {
  return tabs.filter((t) => t.path !== path).map((t) => t.path);
}

/** Paths closed by "Close to the Right" on `path`. */
export function rightOf(tabs: TabLike[], path: string): string[] {
  const index = tabs.findIndex((t) => t.path === path);
  if (index === -1) return [];
  return tabs.slice(index + 1).map((t) => t.path);
}

/** Paths closed by "Close Saved" — every clean tab. */
export function savedTabs(tabs: TabLike[]): string[] {
  return tabs.filter((t) => !t.dirty).map((t) => t.path);
}

/**
 * Move the tab at `from` so it ends up at index `to` (drag reorder).
 * Out-of-range indexes are clamped; a no-op move returns the same array.
 */
export function moveTab<T>(tabs: T[], from: number, to: number): T[] {
  if (from < 0 || from >= tabs.length) return tabs;
  const target = Math.max(0, Math.min(tabs.length - 1, to));
  if (target === from) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** The tab `delta` steps from the active one, wrapping (⌃Tab / ⌃⇧Tab). */
export function cycleTab(
  tabs: TabLike[],
  activeTabPath: string | null,
  delta: number,
): string | null {
  if (tabs.length === 0) return null;
  const index = tabs.findIndex((t) => t.path === activeTabPath);
  if (index === -1) return tabs[0].path;
  const next = (((index + delta) % tabs.length) + tabs.length) % tabs.length;
  return tabs[next].path;
}

/**
 * Tab labels, disambiguated VS Code-style: two `index.ts` tabs show their
 * parent folder as a description so they can be told apart.
 */
export function tabDescriptions(tabs: TabLike[]): Map<string, string> {
  const byLabel = new Map<string, TabLike[]>();
  for (const tab of tabs) {
    const list = byLabel.get(tab.label) ?? [];
    list.push(tab);
    byLabel.set(tab.label, list);
  }
  const out = new Map<string, string>();
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    for (const tab of group) {
      const parts = tab.path.split("/").filter(Boolean);
      if (parts.length > 1) out.set(tab.path, parts[parts.length - 2]);
    }
  }
  return out;
}
