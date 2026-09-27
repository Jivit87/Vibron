/**
 * Contract for one autonomous task: task + workspace in, verified change and
 * evidence out. Used by the headless CLI and the eval runner.
 */

import type { EventSink, FailureClass } from "@/lib/agents/events";
import type { CheckRunner, VerifyServices } from "@/lib/harness/gate";
import type { HookEngine } from "@/lib/hooks/engine";
import type { VerificationReport, VerifyCommand } from "@/lib/verify/types";
import type { WorkspaceHandle } from "@/lib/workspace";

export interface SolveOptions {
  handle: WorkspaceHandle;
  task: string;
  model: string;
  emit: EventSink;
  signal?: AbortSignal;
  runId: string;
  budget: { maxTurns: number; maxTokens?: number; maxWallMs?: number };
  verify: {
    enabled: boolean;
    commands: VerifyCommand[];
    timeoutMs: number;
    baseline: boolean;
  };
  /** Load AGENTS.md / CLAUDE.md etc. (as untrusted conventions). Off by default headless. */
  useRepoRules?: boolean;
  /** Attempts with a fresh context when the first ends without proof. Default 2. */
  maxAttempts?: number;
  /**
   * Review an accepted, strongly verified change with `reviewDiff` (a cheap
   * model); a high-severity finding sends the agent back once with it as a
   * hint. Off unless set.
   */
  review?: boolean;
  /** Model for that review; default: the cheapest agentic model available. */
  reviewModel?: string;
  /**
   * Lifecycle hooks (lib/hooks). Loaded from the workspace, with trust
   * applied, when absent; null disables them. The gate stays the final
   * authority: a Stop hook can hold back a finish, never accept one.
   */
  hooks?: HookEngine | null;
  /** Test seam: run gate/compare commands through this instead of the terminal. */
  runCheck?: CheckRunner;
  /** Test seam: replace `lib/verify` functions (detection, runners, related tests). */
  verifyServices?: Partial<VerifyServices>;
  /**
   * Called once with the final result of a run that produced a change (the
   * memory note is written here). Errors are swallowed; the run's result stands.
   */
  onSolved?: (result: SolveResult) => void | Promise<void>;
  /**
   * Docker sandbox configuration. When enabled, all commands run in isolated
   * containers with resource limits and network restrictions.
   */
  sandbox?: {
    enabled: boolean;
    image?: string;
    memoryMb?: number;
    cpus?: number;
    pidsLimit?: number;
    network?: "none" | "host" | "bridge" | "restricted";
    allowedDomains?: string[];
    startupTimeoutMs?: number;
    extraArgs?: string[];
  };
}

export type SolveStatus = "resolved" | "unverified" | "failed" | "incomplete" | "error";

export interface SolveResult {
  status: SolveStatus;
  summary: string;
  diff: string;
  filesChanged: string[];
  gate: {
    enabled: boolean;
    command: string | null;
    baseline: VerificationReport | null;
    final: VerificationReport | null;
    newFailures: string[];
    fixed: string[];
    rejections: number;
    ranAfterLastEdit: boolean;
    reason: string;
  };
  recovery: {
    checkpoints: number;
    rollbacks: number;
    restoredBest: boolean;
    stuckEvents: number;
    failureClasses: Partial<Record<FailureClass, number>>;
  };
  metrics: {
    modelCalls: number;
    toolCalls: number;
    toolCallsByName: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheHitRate: number;
    costUsd: number;
    uncachedCostUsd: number;
    contextSentTokens: number;
    contextSavedTokens: number;
    compactions: number;
    /** Transcript tokens removed by pruning and eliding (estimate). */
    tokensElided?: number;
    /** Model turns cut off by the output cap that the loop recovered from. */
    truncationRecoveries?: number;
    verifyRuns: number;
    verifyMs: number;
    durationMs: number;
  };
  error?: string;
}
