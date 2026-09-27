"use client";

/**
 * Background-session alerts ("needs approval", "finished", "failed").
 *
 * In the desktop app they go through the Electron preload's native
 * notification bridge, so they are seen even when the window is behind
 * another app. In a browser (or an Electron build whose preload predates
 * `notify`) they fall back to an in-app toast with an action that opens the
 * session. No web Notification API: it needs a permission prompt and does
 * not exist in every Electron context.
 */

import { toast } from "sonner";

export type SessionNoticeTone = "approval" | "done" | "error";

export interface SessionNotice {
  title: string;
  body?: string;
  tone: SessionNoticeTone;
  /** Switch to the session (the toast's action in the browser). */
  onOpen?: () => void;
}

export function notifySession(notice: SessionNotice): void {
  const native = typeof window !== "undefined" ? window.electronAPI?.notify : undefined;
  if (native) {
    try {
      void Promise.resolve(native({ title: notice.title, body: notice.body })).catch(() =>
        showToast(notice),
      );
      return;
    } catch {
      // Fall through to the toast.
    }
  }
  showToast(notice);
}

function showToast(notice: SessionNotice): void {
  const options = {
    description: notice.body,
    ...(notice.onOpen ? { action: { label: "Open", onClick: notice.onOpen } } : {}),
  };
  if (notice.tone === "approval") toast.warning(notice.title, { ...options, duration: 12_000 });
  else if (notice.tone === "done") toast.success(notice.title, options);
  else toast.error(notice.title, options);
}
