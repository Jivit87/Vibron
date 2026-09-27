/**
 * Request bodies shared by the browser and the harness routes.
 *
 * The server never trusts these shapes blindly — every route re-validates —
 * but both sides compile against the same definitions so drift shows up as a
 * type error rather than a silent 400.
 */

import type { ApprovalDecision, RunPlan } from "@/lib/agents/events";
import type { ContextAttachment, ImageAttachment } from "@/lib/composer/types";

/** What the composer is asking for: build it, plan it first, or just answer. */
export type Interaction = "agent" | "plan" | "ask" | "fix";

export interface AgentRequest {
  repoKey: string;
  prompt: string;
  history: { role: "user" | "assistant"; content: string }[];
  interaction: Interaction;
  /** Team vs solo; only meaningful when `interaction` is "agent". */
  mode: "auto" | "single" | "orchestrated";
  /** Execute this user-approved plan instead of planning again. */
  plan?: RunPlan;
  /** The plan version `plan` came from; an edited plan is saved as its child. */
  planVersionId?: string;
  model: string;
  commandPolicy: "auto" | "ask" | "never";
  editPolicy?: "auto" | "ask";
  concurrency: number;
  showThinking: boolean;
  autoCheckpoint: boolean;
  /** graph_search defaults: hops from seed symbols (1-4) and symbol cap (5-60). */
  retrievalDepth?: number;
  maxNodes?: number;
  attachments?: ContextAttachment[];
  images?: ImageAttachment[];
  /** Run inside this session (see docs/MULTI_SESSION.md). Absent = a sessionless run. */
  sessionId?: string;
}

/** POST /api/agent/cancel */
export interface CancelRequest {
  runId: string;
}

/** POST /api/agent/approve */
export interface ApproveRequest {
  approvalId: string;
  decision: ApprovalDecision;
}

/** GET /api/agent/rules?repoKey= */
export interface RulesResponse {
  files: {
    path: string;
    source: "agents" | "claude" | "cursor" | "viberon";
    tokens: number;
  }[];
}

/** Response header carrying the run id, duplicated in `run_start`. */
export const RUN_ID_HEADER = "X-Run-Id";
