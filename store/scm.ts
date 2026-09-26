"use client";

/**
 * Source-control state (client).
 *
 * A separate slice from `store/viberon.ts` so the Source Control view and
 * the status-bar branch indicator share one snapshot without widening the
 * main store. Every mutation returns the fresh snapshot, so the UI never
 * needs a second round-trip after an action.
 */

import { create } from "zustand";

import { isMockMode, MOCK_GIT_SNAPSHOT } from "@/lib/client/mock-run";
import type { GitSnapshot } from "@/lib/client/workspace-types";

export type { GitSnapshot };

export type ScmOp =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "switch"
  | "createBranch"
  | "init"
  | "fetch"
  | "pull"
  | "push";

interface ScmState {
  snapshot: GitSnapshot | null;
  /** The git API is not available on this server (404). */
  unavailable: boolean;
  loading: boolean;
  error: string | null;
  /** The op currently in flight, for per-button spinners. */
  busy: ScmOp | "generate" | null;
  commitMessage: string;

  setCommitMessage: (message: string) => void;
  refresh: (repoKey: string) => Promise<void>;
  run: (
    repoKey: string,
    op: ScmOp,
    payload?: { paths?: string[]; all?: boolean; message?: string; name?: string },
  ) => Promise<{ ok: boolean; error?: string; output?: string }>;
  generateMessage: (repoKey: string, model?: string) => Promise<{ ok: boolean; error?: string }>;
  reset: () => void;
}

type SnapshotBody = GitSnapshot & { error?: string; output?: string };

let refreshSeq = 0;

export const useScm = create<ScmState>((set, get) => ({
  snapshot: null,
  unavailable: false,
  loading: false,
  error: null,
  busy: null,
  commitMessage: "",

  setCommitMessage: (commitMessage) => set({ commitMessage }),

  reset: () => set({ snapshot: null, error: null, busy: null, commitMessage: "" }),

  refresh: async (repoKey) => {
    if (!repoKey) return;
    const seq = ++refreshSeq;
    if (isMockMode()) {
      set({ snapshot: get().snapshot ?? MOCK_GIT_SNAPSHOT, loading: false, error: null });
      return;
    }
    set({ loading: true });
    try {
      const response = await fetch(`/api/git?repoKey=${encodeURIComponent(repoKey)}`);
      if (response.status === 404) {
        if (seq === refreshSeq) set({ unavailable: true, loading: false, error: null });
        return;
      }
      const body = (await response.json()) as SnapshotBody;
      if (seq !== refreshSeq) return;
      if (body.virtual) {
        set({
          snapshot: { virtual: true, isRepo: false, gitAvailable: true, parentRepo: null },
          error: null,
          loading: false,
        });
        return;
      }
      if (!response.ok) {
        set({ error: body.error ?? "Could not read the repository.", loading: false });
        return;
      }
      set({ snapshot: body, error: null, loading: false });
    } catch {
      if (seq === refreshSeq) set({ loading: false, error: "Network error" });
    }
  },

  run: async (repoKey, op, payload = {}) => {
    if (get().busy) return { ok: false, error: "Another git operation is running." };
    if (isMockMode()) return mockOp(op, payload);
    set({ busy: op });
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, op, ...payload }),
      });
      const body = (await response.json().catch(() => ({}))) as SnapshotBody;
      if (!response.ok) {
        // A failed op may still have changed state (e.g. a half-applied
        // pull), so re-read rather than trust the old snapshot.
        void get().refresh(repoKey);
        return { ok: false, error: body.error ?? `git ${op} failed` };
      }
      // Invalidate any refresh that started before the mutation landed.
      refreshSeq += 1;
      set({ snapshot: body, error: null });
      return { ok: true, output: body.output };
    } catch {
      return { ok: false, error: "Network error" };
    } finally {
      set({ busy: null });
    }
  },

  generateMessage: async (repoKey, model) => {
    if (get().busy) return { ok: false, error: "Another git operation is running." };
    set({ busy: "generate" });
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, op: "generateMessage", model }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok || !body.message) {
        return { ok: false, error: body.error ?? "Could not generate a message." };
      }
      set({ commitMessage: body.message });
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error" };
    } finally {
      set({ busy: null });
    }
  },
}));

/** Apply an op to the fixture so the mock view responds to clicks. */
function mockOp(
  op: ScmOp,
  payload: { paths?: string[]; all?: boolean; message?: string },
): { ok: boolean; output?: string } {
  const snapshot = useScm.getState().snapshot ?? MOCK_GIT_SNAPSHOT;
  const status = snapshot.status;
  if (!status) return { ok: true };
  const hit = (path: string) => payload.all || (payload.paths ?? []).includes(path);
  let files = status.files;
  if (op === "stage") {
    files = files.map((f) =>
      hit(f.path) && f.group !== "conflicts" ? { ...f, group: "staged" as const } : f,
    );
  } else if (op === "unstage") {
    files = files.map((f) =>
      hit(f.path) && f.group === "staged" ? { ...f, group: "changes" as const } : f,
    );
  } else if (op === "discard") {
    files = files.filter((f) => !(hit(f.path) && f.group !== "staged"));
  } else if (op === "commit") {
    files = files.filter((f) => f.group !== "staged");
    useScm.setState({ commitMessage: "" });
  }
  useScm.setState({ snapshot: { ...snapshot, status: { ...status, files } } });
  return { ok: true, output: `mock ${op}` };
}

/** Tab path prefix for diff tabs opened from the Source Control view. */
export const DIFF_TAB_PREFIX = "__diff__:";

export type DiffMode = "staged" | "changes" | "untracked";

export function diffTabPath(mode: DiffMode, filePath: string): string {
  return `${DIFF_TAB_PREFIX}${mode}:${filePath}`;
}

export function parseDiffTabPath(
  tabPath: string,
): { mode: DiffMode; path: string } | null {
  if (!tabPath.startsWith(DIFF_TAB_PREFIX)) return null;
  const rest = tabPath.slice(DIFF_TAB_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const mode = rest.slice(0, colon);
  if (mode !== "staged" && mode !== "changes" && mode !== "untracked") return null;
  return { mode, path: rest.slice(colon + 1) };
}
