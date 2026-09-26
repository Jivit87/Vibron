/**
 * Agent-edit review, Cursor-style.
 *
 * A run streams `file_change` records. For review, what matters per file is
 * the *net* change: the content before the run first touched it (`base`)
 * versus what it holds now (`current`). This module folds the raw change
 * list into one pending review per file and filters out anything the user
 * already accepted or rejected.
 */

export interface ChangeLike {
  id: string;
  kind: "create" | "update" | "delete" | "rename";
  path: string;
  previousPath?: string;
  before: string | null;
  after: string | null;
  adds: number;
  removes: number;
  reverted: boolean;
}

export interface PendingReview {
  path: string;
  /** Set when the net change includes a rename; the original location. */
  previousPath?: string;
  kind: "create" | "update" | "delete" | "rename";
  /** Content before the run touched the file; null if it did not exist. */
  base: string | null;
  /** Content after the agent's last edit; null if it was deleted. */
  current: string | null;
  adds: number;
  removes: number;
  /** Every change record folded into this review (for marking reverted). */
  changeIds: string[];
}

export type ReviewDecision = "accepted" | "rejected";

/** Key used to remember a decision for one file within one run. */
export function reviewKey(runId: string, path: string): string {
  return `${runId}::${path}`;
}

/**
 * Fold a run's change list into one pending review per file, oldest-first.
 * Reverted changes and files with a recorded decision are skipped, as are
 * files whose net effect is nothing (created then deleted, or edited back
 * to the original text).
 */
export function pendingReviews(
  runId: string,
  changes: readonly ChangeLike[],
  decisions: Readonly<Record<string, ReviewDecision>>,
): PendingReview[] {
  const byPath = new Map<string, PendingReview>();

  for (const change of changes) {
    if (change.reverted) continue;

    // A rename moves the pending review to its new path, keeping the base.
    const carried =
      change.kind === "rename" && change.previousPath
        ? byPath.get(change.previousPath)
        : undefined;
    if (carried && change.previousPath) byPath.delete(change.previousPath);

    const existing = carried ?? byPath.get(change.path);
    if (existing) {
      byPath.set(change.path, {
        ...existing,
        path: change.path,
        previousPath:
          change.kind === "rename"
            ? (existing.previousPath ?? change.previousPath)
            : existing.previousPath,
        kind: netKind(existing.kind, change.kind),
        current: change.after,
        adds: existing.adds + change.adds,
        removes: existing.removes + change.removes,
        changeIds: [...existing.changeIds, change.id],
      });
    } else {
      byPath.set(change.path, {
        path: change.path,
        previousPath: change.kind === "rename" ? change.previousPath : undefined,
        kind: change.kind,
        base: change.before,
        current: change.after,
        adds: change.adds,
        removes: change.removes,
        changeIds: [change.id],
      });
    }
  }

  return [...byPath.values()].filter((review) => {
    if (decisions[reviewKey(runId, review.path)]) return false;
    // Net no-op: nothing to review.
    if (review.base === review.current && !review.previousPath) return false;
    return true;
  });
}

function netKind(
  first: PendingReview["kind"],
  next: PendingReview["kind"],
): PendingReview["kind"] {
  if (first === "create") return next === "delete" ? "delete" : "create";
  if (next === "delete") return "delete";
  if (first === "rename" || next === "rename") return "rename";
  return "update";
}

/** Paths a rejection must restore: the file itself and, for a rename, its origin. */
export function pathsToRestore(review: PendingReview): string[] {
  return review.previousPath ? [review.path, review.previousPath] : [review.path];
}
