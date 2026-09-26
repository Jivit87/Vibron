"use client";

/**
 * Hand context to whichever composer is visible. The composer listens for
 * `viberon:attach`; if the IDE's agent dock is hidden we switch to Chat so
 * there is a composer to receive it.
 */

import type { ContextAttachment } from "@/lib/composer/types";
import { problemsToText, type Problem } from "@/lib/client/workspace-types";
import { useViberon } from "@/store/viberon";

export function attachToComposer(item: ContextAttachment): void {
  const store = useViberon.getState();
  const dockVisible =
    store.appMode === "ide" && store.agentDockOpen && typeof window !== "undefined" && window.innerWidth >= 1080;
  if (!dockVisible) store.setAppMode("chat");
  // Wait a frame so a freshly mounted composer has its listener attached.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("viberon:attach", { detail: item }))),
  );
}

export function attachProblems(problems: readonly Problem[]): void {
  if (problems.length === 0) return;
  attachToComposer({ kind: "problems", content: problemsToText(problems) });
}
