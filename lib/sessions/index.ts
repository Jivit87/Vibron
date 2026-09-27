/**
 * The process-wide session manager, wired to the real run registry, the
 * headless worktree machinery and the workspace registry.
 *
 * Lives on globalThis (dev-mode HMR must not fork it). Limits persist in the
 * app store under `sessions:config`; abandoned sessions are swept every few
 * minutes by an unref'd timer, and opportunistically on every list.
 */

import { cancelRun, getRun } from "@/lib/harness/runs";
import { createWorktree, removeWorktree } from "@/lib/headless/worktree";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { SessionManager } from "@/lib/sessions/manager";
import type { SessionConfig } from "@/lib/sessions/types";
import { getLocalWorkspace, getValueRaw, setValueRaw } from "@/lib/store";

export { SessionError, SessionManager } from "@/lib/sessions/manager";
export type * from "@/lib/sessions/types";

const CONFIG_KEY = "sessions:config";
const SWEEP_EVERY_MS = 5 * 60 * 1000;

interface Holder {
  manager: SessionManager;
  configLoaded: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
}

const KEY = Symbol.for("viberon.sessions.manager");
type GlobalWithSessions = typeof globalThis & { [KEY]?: Holder };
const host = globalThis as GlobalWithSessions;

function build(): Holder {
  const manager = new SessionManager({
    cancelRun,
    isRunLive: (runId) => Boolean(getRun(runId)),
    worktrees: {
      rootFor: async (repoKey) => (await getLocalWorkspace(repoKey))?.rootPath ?? null,
      create: (repoRoot, name) => createWorktree(repoRoot, name, { label: "An isolated session" }),
      register: async (dir) => (await registerLocalWorkspace(dir)).repoKey,
      remove: removeWorktree,
    },
  });
  const holder: Holder = { manager, configLoaded: null, timer: null };
  if (process.env.VITEST === undefined) {
    holder.timer = setInterval(() => void manager.sweep().catch(() => []), SWEEP_EVERY_MS);
    holder.timer.unref?.();
  }
  return holder;
}

function holder(): Holder {
  host[KEY] ??= build();
  return host[KEY];
}

/** The shared manager, with persisted limits applied. */
export async function getSessionManager(): Promise<SessionManager> {
  const h = holder();
  h.configLoaded ??= getValueRaw<Partial<SessionConfig>>(CONFIG_KEY)
    .then((saved) => {
      if (saved) h.manager.configure(saved);
    })
    .catch(() => undefined);
  await h.configLoaded;
  return h.manager;
}

/** Change and persist the limits. */
export async function saveSessionConfig(patch: Partial<SessionConfig>): Promise<SessionConfig> {
  const manager = await getSessionManager();
  const config = manager.configure(patch);
  await setValueRaw(CONFIG_KEY, config);
  return config;
}
