/**
 * What a queued task does. `fix`: solve → (deliver when resolved and asked)
 * → (report on the issue); a fix for a GitHub issue runs in a fresh worktree
 * of origin/<default> with the issue's current text. `review`: one `reviewDiff` call over the work
 * tree's changes, or over a PR when the task text is a PR URL.
 */

import { resolveModel } from "@/lib/ai";
import type { OrchestrationEvent } from "@/lib/agents/events";
import {
  createIssueWorktree,
  deliver,
  evidenceFromResult,
  removeIssueWorktree,
  renderPrBody,
  reportOnIssue,
  titleFromTask,
} from "@/lib/deliver";
import { parsePrUrl } from "@/lib/github-api";
import { recordFixNote } from "@/lib/memory/graph";
import { fetchIssueTask } from "@/lib/issues";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import type { Task, TaskOutcome, TaskRunner } from "@/lib/tasks";
import { diffForTarget, reviewDiff, reviewModel } from "@/lib/review";
import { detectVerifyCommands } from "@/lib/verify";
import { openWorkspace } from "@/lib/workspace";

export const runFixTask: TaskRunner = async (task, { emit, signal }) => {
  const home = (await openWorkspace(task.repoKey)).rootPath;
  if (!home) throw new Error("Fix tasks need a workspace on disk. Open a local folder or clone the repository first.");
  if (!task.issueUrl) return fixIn(task, home, home, task.task, { emit, signal });

  // An issue fix runs in its own worktree of origin/<default>: one fix per
  // PR, from a clean base, without touching the user's checkout.
  const { text, issue } = await fetchIssueTask(task.issueUrl);
  const tree = await createIssueWorktree(home);
  try {
    const meta = await registerLocalWorkspace(tree.dir);
    return await fixIn({ ...task, repoKey: meta.repoKey }, tree.dir, home, text, {
      emit,
      signal,
      title: `Fix #${issue.number}: ${issue.title}`,
      baseBranch: tree.base,
    });
  } finally {
    await removeIssueWorktree(home, tree.dir);
  }
};

/** solve → (deliver when resolved and asked) → (report on the issue). */
async function fixIn(
  task: Task,
  root: string,
  memoryRoot: string,
  text: string,
  ctx: { emit: (event: OrchestrationEvent) => void; signal: AbortSignal; title?: string; baseBranch?: string },
): Promise<TaskOutcome> {
  const handle = await openWorkspace(task.repoKey);
  const { solveTask } = await import("@/lib/harness/solve");
  const model = await resolveModel(task.model ?? "auto", { agenticOnly: true });
  const commands = await detectVerifyCommands(root).catch(() => []);
  const result = await solveTask({
    handle,
    task: text,
    model,
    emit: ctx.emit,
    signal: ctx.signal,
    runId: task.id,
    budget: { maxTurns: 40 },
    verify: { enabled: true, commands, timeoutMs: 300_000, baseline: true },
    useRepoRules: true,
    review: true,
    onSolved: (solved) => {
      if (!solved.filesChanged.length) return;
      recordFixNote(memoryRoot, {
        issue: ctx.title ?? task.task,
        files: solved.filesChanged,
        rootCause: solved.summary,
        verified: solved.status === "resolved",
      });
    },
  });
  if (result.status !== "resolved" && result.status !== "unverified") {
    return { result, error: result.error ?? `The fix ended ${result.status}: ${result.gate.reason || result.summary}`.slice(0, 500) };
  }
  if (!task.deliver) return { result };
  if (result.status !== "resolved") {
    return { result, note: "Not delivered: no check proved the change. Review it and deliver by hand." };
  }

  const evidence = evidenceFromResult(result);
  const outcome: TaskOutcome = { result };
  try {
    const pr = await deliver({
      root,
      title: ctx.title ?? titleFromTask(task.task),
      body: renderPrBody({ summary: result.summary, evidence, issueUrl: task.issueUrl }),
      expectedFiles: result.filesChanged,
      ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
    });
    outcome.prUrl = pr.prUrl;
  } catch (error) {
    return { result, error: `Delivery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (task.issueUrl) {
    await reportOnIssue({ issueUrl: task.issueUrl, prUrl: outcome.prUrl!, summary: result.summary, evidence }).catch(
      (error: unknown) => {
        outcome.note = `The PR is open, but commenting on the issue failed: ${error instanceof Error ? error.message : String(error)}`;
      },
    );
  }
  return outcome;
}

export const runReviewTask: TaskRunner = async (task, { emit, signal }) => {
  const startedAt = Date.now();
  const prUrl = parsePrUrl(task.task.trim()) ? task.task.trim() : undefined;
  const root = prUrl ? null : (await openWorkspace(task.repoKey)).rootPath;
  const diff = await diffForTarget(root, prUrl ? { prUrl } : "working");
  if (!diff.trim()) throw new Error("Nothing to review: there are no uncommitted changes.");
  const model = await reviewModel(task.model);
  emit({ type: "run_start", runId: task.id, mode: "single", model, at: startedAt });
  const result = await reviewDiff({ diff, task: prUrl ? undefined : task.task, model, signal, root: root ?? undefined });
  emit({
    type: "run_done",
    status: "done",
    summary: result.summary,
    filesChanged: 0,
    durationMs: Date.now() - startedAt,
    costUsd: 0,
  });
  return { result };
};
