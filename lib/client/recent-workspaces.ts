/**
 * Recently opened workspaces, kept in localStorage for the Welcome page.
 * There is no server list of workspaces, so the browser remembers what it
 * has opened.
 */

export interface RecentWorkspace {
  repoKey: string;
  label: string;
  rootPath?: string;
  openedAt: number;
}

const KEY = "viberon.recentWorkspaces.v1";
const MAX = 10;

export function mergeRecent(
  list: readonly RecentWorkspace[],
  entry: RecentWorkspace,
  max = MAX,
): RecentWorkspace[] {
  return [entry, ...list.filter((w) => w.repoKey !== entry.repoKey)].slice(0, max);
}

export function loadRecentWorkspaces(): RecentWorkspace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (w): w is RecentWorkspace =>
            Boolean(w) && typeof w.repoKey === "string" && typeof w.label === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function recordWorkspace(entry: Omit<RecentWorkspace, "openedAt">): void {
  if (typeof window === "undefined" || !entry.repoKey) return;
  try {
    const next = mergeRecent(loadRecentWorkspaces(), { ...entry, openedAt: Date.now() });
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable; the list simply is not remembered.
  }
}

/** Ask Electron for a folder, register it, and navigate there. */
export async function openFolderDialog(): Promise<{ ok: boolean; error?: string }> {
  if (typeof window === "undefined" || !window.electronAPI?.openFolder) {
    return { ok: false, error: "Opening a folder needs the desktop app." };
  }
  const result = await window.electronAPI.openFolder();
  if (result.canceled || !result.path) return { ok: true };
  const response = await fetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPath: result.path }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? "Could not open that folder." };
  }
  const body = (await response.json()) as { repoKey: string };
  window.location.href = `/workspace/${body.repoKey}`;
  return { ok: true };
}
