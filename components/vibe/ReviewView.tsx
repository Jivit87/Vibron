"use client";

/**
 * Agent-edit review: every file the last run touched, net of repeated
 * edits, with a side-by-side diff and per-file / bulk accept and reject.
 * Rejecting restores the content from before the run.
 */

import { useMemo, useState } from "react";
import { Check, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { refreshWorkspace } from "@/lib/client/agent-stream";
import { isMockMode } from "@/lib/client/mock-run";
import { pathsToRestore, pendingReviews, reviewKey, type PendingReview } from "@/lib/editor/review";
import { useViberon } from "@/store/viberon";
import { DiffView } from "@/components/vibe/DiffView";
import { KindLetter } from "@/components/vibe/AgentRunView";
import { DiffCounts, EmptyState, IconButton, splitPath } from "@/components/vibe/primitives";

async function writeFile(repoKey: string, path: string, source: string): Promise<boolean> {
  const response = await fetch(`/api/repos/files/${repoKey}?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  }).catch(() => null);
  return Boolean(response?.ok);
}

async function deleteFile(repoKey: string, path: string): Promise<boolean> {
  const response = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey, op: "delete", path }),
  }).catch(() => null);
  return Boolean(response?.ok);
}

/** Put the workspace back the way it was before the run touched this file. */
async function restore(repoKey: string, review: PendingReview): Promise<boolean> {
  if (isMockMode()) return true;
  if (review.previousPath) {
    const ok = await deleteFile(repoKey, review.path);
    return ok && (review.base === null || (await writeFile(repoKey, review.previousPath, review.base)));
  }
  if (review.base === null) return deleteFile(repoKey, review.path);
  return writeFile(repoKey, review.path, review.base);
}

export function ReviewView() {
  const run = useViberon((s) => s.run);
  const decisions = useViberon((s) => s.reviewDecisions);
  const repoKey = useViberon((s) => s.repoKey);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reviews = useMemo(
    () => (run ? pendingReviews(run.id, run.changes, decisions) : []),
    [run, decisions],
  );
  const current = reviews.find((r) => r.path === selected) ?? reviews[0];

  if (!run || reviews.length === 0) {
    return (
      <div className="mx-auto max-w-[720px] px-6 py-8">
        <EmptyState title="Nothing to review" body="Files an agent changes in a run appear here until you accept or reject them." />
      </div>
    );
  }

  async function decide(targets: PendingReview[], decision: "accepted" | "rejected") {
    if (!run) return;
    setBusy(true);
    try {
      const store = useViberon.getState();
      const done: Record<string, "accepted" | "rejected"> = {};
      for (const review of targets) {
        if (decision === "rejected") {
          const ok = await restore(repoKey, review);
          if (!ok) {
            toast.error(`Could not restore ${review.path}`);
            continue;
          }
          for (const id of review.changeIds) store.markChangeReverted(id);
          // Open tabs follow the restore: the file that no longer exists
          // closes, the one that got its content back shows it.
          const restoredPath = review.previousPath ?? review.path;
          for (const path of pathsToRestore(review)) {
            if (path === restoredPath && review.base !== null) store.updateTabSource(path, review.base, false);
            else store.closeTab(path);
          }
        }
        done[reviewKey(run.id, review.path)] = decision;
      }
      store.setReviewDecisions(done);
      if (decision === "rejected") void refreshWorkspace();
    } finally {
      setBusy(false);
    }
  }

  const adds = reviews.reduce((n, r) => n + r.adds, 0);
  const removes = reviews.reduce((n, r) => n + r.removes, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: "var(--vb-line)" }}>
        <span className="text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
          {reviews.length} file{reviews.length === 1 ? "" : "s"} to review
        </span>
        <DiffCounts adds={adds} removes={removes} />
        <span className="min-w-0 truncate text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
          {run.prompt}
        </span>
        <div className="flex-1" />
        <button type="button" className="vb-btn" disabled={busy} onClick={() => void decide(reviews, "rejected")}>
          Reject all
        </button>
        <button type="button" className="vb-btn vb-btn-primary" disabled={busy} onClick={() => void decide(reviews, "accepted")}>
          Accept all
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[260px] shrink-0 overflow-y-auto border-r py-1" style={{ borderColor: "var(--vb-line)" }}>
          {reviews.map((review) => {
            const { name, dir } = splitPath(review.path);
            const active = review.path === current?.path;
            return (
              <div
                key={review.path}
                data-selected={active}
                onClick={() => setSelected(review.path)}
                className="vb-row group cursor-pointer"
                title={review.previousPath ? `${review.previousPath} → ${review.path}` : review.path}
              >
                <KindLetter kind={review.kind} />
                <span className="truncate">{name}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
                  {dir}
                </span>
                <span className="hidden group-hover:flex" onClick={(e) => e.stopPropagation()}>
                  <IconButton title="Reject (restore original)" disabled={busy} onClick={() => void decide([review], "rejected")}>
                    <Undo2 className="size-3.5" />
                  </IconButton>
                  <IconButton title="Accept" disabled={busy} onClick={() => void decide([review], "accepted")}>
                    <Check className="size-3.5" />
                  </IconButton>
                </span>
                <span className="group-hover:hidden">
                  <DiffCounts adds={review.adds} removes={review.removes} />
                </span>
              </div>
            );
          })}
        </div>
        {current && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-[30px] shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: "var(--vb-line)" }}>
              <span className="truncate font-mono text-[12px]" style={{ color: "var(--vb-text)" }}>
                {current.previousPath ? `${current.previousPath} → ${current.path}` : current.path}
              </span>
              <div className="flex-1" />
              <button type="button" className="vb-btn vb-btn-ghost" disabled={busy} onClick={() => void decide([current], "rejected")}>
                Reject
              </button>
              <button type="button" className="vb-btn" disabled={busy} onClick={() => void decide([current], "accepted")}>
                Accept
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <DiffView path={current.path} original={current.base ?? ""} modified={current.current ?? ""} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
