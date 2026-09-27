/**
 * The hook engine: one per run. It holds the hooks that are allowed to run
 * (the user's global hooks, trusted workspace hooks, in-process hooks),
 * dispatches each hook point, folds the individual decisions into one, and
 * reports every execution to the run's event stream and the recent-runs log.
 *
 * Combining rules, in order global → workspace → in-process:
 *   PreToolUse        the first deny wins; `updatedInput` chains (each hook
 *                     sees the input as modified by the previous one)
 *   PostToolUse       feedback from every hook is appended, in order
 *   Stop              any deny keeps the agent working
 *   UserPromptSubmit  the first deny rejects the prompt; context is joined
 *   SessionStart      context is joined; it cannot block
 *
 * An "allow" is only the absence of an objection. It never bypasses a
 * Viberon policy: command classification, approvals, write scope and the
 * verification gate all still apply to whatever a hook lets through.
 */

import { randomUUID } from "node:crypto";

import type { EventSink } from "@/lib/agents/events";
import {
  globalHooksPath,
  readHooksFile,
  workspaceHooksPath,
  WORKSPACE_HOOKS_FILE,
  type HooksFileRead,
} from "@/lib/hooks/config";
import { runHookCommand, type HookExecutor } from "@/lib/hooks/exec";
import { compileMatcher } from "@/lib/hooks/matcher";
import { capText, normalizeHookResult, parseCommandRun, type ParsedHookRun } from "@/lib/hooks/protocol";
import { getTrustRecord, trustStateFor, type TrustState } from "@/lib/hooks/trust";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  STREAM_EVENT,
  TOOL_EVENTS,
  type CommandHook,
  type HookEventName,
  type HookInput,
  type HookOutcome,
  type HookResult,
  type HookRunRecord,
  type HookSource,
  type InProcessHook,
} from "@/lib/hooks/types";

/** Lane id for hook runs that belong to the run rather than one agent. */
export const SESSION_AGENT_ID = "session";

/** Tool output sent to PostToolUse hooks is capped. */
const MAX_TOOL_RESPONSE = 20_000;

/* ------------------------- in-process registry --------------------------- */

const REGISTRY_KEY = Symbol.for("viberon.hooks.registry");
const RECENT_KEY = Symbol.for("viberon.hooks.recent");
type GlobalWithHooks = typeof globalThis & {
  [REGISTRY_KEY]?: Set<InProcessHook>;
  [RECENT_KEY]?: Map<string, HookRunRecord[]>;
};
const host = globalThis as GlobalWithHooks;
const registry: Set<InProcessHook> = host[REGISTRY_KEY] ?? new Set();
host[REGISTRY_KEY] = registry;
const recent: Map<string, HookRunRecord[]> = host[RECENT_KEY] ?? new Map();
host[RECENT_KEY] = recent;

const MAX_RECENT = 100;

/**
 * Register a hook implemented in TypeScript for every run in this process.
 * Returns the function that unregisters it.
 */
export function registerHook(hook: InProcessHook): () => void {
  if (TOOL_EVENTS.has(hook.event) && compileMatcher(hook.matcher).error) {
    throw new Error(compileMatcher(hook.matcher).error);
  }
  registry.add(hook);
  return () => {
    registry.delete(hook);
  };
}

export function registeredHooks(): InProcessHook[] {
  return [...registry];
}

export function recentHookRuns(repoKey: string, limit = 50): HookRunRecord[] {
  return (recent.get(repoKey) ?? []).slice(-limit).reverse();
}

export function clearHookStateForTests(): void {
  registry.clear();
  recent.clear();
}

function remember(record: HookRunRecord): void {
  const list = recent.get(record.repoKey) ?? [];
  list.push(record);
  if (list.length > MAX_RECENT) list.splice(0, list.length - MAX_RECENT);
  recent.set(record.repoKey, list);
}

/* -------------------------------- engine --------------------------------- */

type EngineHook = CommandHook | (InProcessHook & { kind: "builtin" });

export interface HookEngineOptions {
  /** Hooks allowed to run (already trust-filtered). */
  hooks?: CommandHook[];
  /** In-process hooks. Default: everything in the process registry. */
  builtins?: InProcessHook[];
  /** Workspace root; command hooks need one to run in. */
  cwd: string | null;
  repoKey: string;
  runId: string;
  emit?: EventSink;
  signal?: AbortSignal;
  /** Test seam for command execution. */
  exec?: HookExecutor;
}

export interface PreToolDecision {
  decision: "allow" | "deny";
  reason?: string;
  input: Record<string, unknown>;
  modified: boolean;
  /** Extra context for the model, appended to the tool result. */
  context?: string;
}

export class HookEngine {
  private readonly hooks: EngineHook[];
  private readonly exec: HookExecutor;
  /** Every hook run by this engine, in order (for evidence bundles). */
  readonly records: HookRunRecord[] = [];
  /** Why configured hooks were left out (untrusted or changed workspace file, config errors). */
  readonly notices: string[] = [];

  constructor(private readonly opts: HookEngineOptions) {
    const builtins = (opts.builtins ?? registeredHooks()).map((h) => ({ ...h, kind: "builtin" as const }));
    // Command hooks need a folder to run in; without one only in-process hooks apply.
    const commands = opts.cwd ? (opts.hooks ?? []) : [];
    this.hooks = [...commands, ...builtins];
    this.exec = opts.exec ?? runHookCommand;
  }

  get isEmpty(): boolean {
    return this.hooks.length === 0;
  }

  /** Whether any hook listens for `event` (and `tool`, for tool events). */
  has(event: HookEventName, tool?: string): boolean {
    return this.matching(event, tool).length > 0;
  }

  private matching(event: HookEventName, tool?: string): EngineHook[] {
    return this.hooks.filter(
      (h) => h.event === event && (!TOOL_EVENTS.has(event) || compileMatcher(h.matcher).test(tool ?? "")),
    );
  }

  private base(event: HookEventName, agentId?: string): HookInput {
    return {
      hook_event_name: event,
      session_id: this.opts.runId,
      cwd: this.opts.cwd ?? "",
      ...(agentId && agentId !== SESSION_AGENT_ID ? { agent_id: agentId } : {}),
    };
  }

  private async invoke(hook: EngineHook, input: HookInput): Promise<ParsedHookRun & { exitCode: number | null; timedOut: boolean; durationMs: number }> {
    if (hook.kind === "command") {
      const run = await this.exec({
        command: hook.command,
        stdin: JSON.stringify(input),
        cwd: this.opts.cwd!,
        repoKey: this.opts.repoKey,
        timeoutMs: hook.timeoutMs,
        runId: this.opts.runId,
        signal: this.opts.signal,
        env: {
          VIBERON_HOOK_EVENT: input.hook_event_name,
          VIBERON_PROJECT_DIR: this.opts.cwd!,
          // Scripts written for Claude Code read this name.
          CLAUDE_PROJECT_DIR: this.opts.cwd!,
        },
      });
      return { ...parseCommandRun(input.hook_event_name, run), exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs };
    }

    const startedAt = Date.now();
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    this.opts.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, timeoutMs);
      });
      // A structuredClone keeps a hook from mutating the caller's objects in place.
      const raced = await Promise.race([
        Promise.resolve(hook.run(structuredClone(input), { signal: controller.signal })),
        timeout,
      ]);
      const durationMs = Date.now() - startedAt;
      if (raced === "timeout") {
        return { status: "error", message: "hook timed out", exitCode: null, timedOut: true, durationMs };
      }
      return { status: "ok", result: normalizeHookResult(raced ?? {}), exitCode: 0, timedOut: false, durationMs };
    } catch (error) {
      return {
        status: "error",
        message: `hook threw: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Run one hook, record and emit it, and return its (normalized) result. */
  private async runHook(hook: EngineHook, input: HookInput, agentId: string): Promise<HookResult | null> {
    const run = await this.invoke(hook, input);
    const result = run.status === "ok" ? run.result : null;
    let outcome: HookOutcome = "proceed";
    let message = "";
    if (run.status === "error") {
      outcome = "error";
      message = run.message;
    } else if (result?.decision === "deny") {
      outcome = "blocked";
      message = result.reason ?? "";
    } else if (result?.updatedInput && input.hook_event_name === "PreToolUse") {
      outcome = "modified";
      message = result.reason ?? "tool input modified";
    } else {
      message = result?.additionalContext ?? result?.reason ?? "";
    }
    const source: HookSource = hook.kind === "command" ? hook.source : "builtin";
    const label = hook.kind === "command" ? hook.command : hook.name;
    const record: HookRunRecord = {
      id: randomUUID(),
      at: Date.now(),
      repoKey: this.opts.repoKey,
      runId: this.opts.runId,
      event: input.hook_event_name,
      source,
      label,
      ...(agentId !== SESSION_AGENT_ID ? { agentId } : {}),
      ...(input.tool_name ? { tool: input.tool_name } : {}),
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      outcome,
      message: capText(message, 1_000),
    };
    this.records.push(record);
    remember(record);
    this.opts.emit?.({
      type: "hook",
      agentId,
      event: STREAM_EVENT[input.hook_event_name],
      command: label,
      exitCode: run.exitCode,
      blocked: outcome === "blocked",
      output: record.message,
      source,
      outcome,
      durationMs: run.durationMs,
      ...(input.tool_name ? { tool: input.tool_name } : {}),
    });
    return result;
  }

  async preToolUse(call: { agentId: string; tool: string; input: Record<string, unknown> }): Promise<PreToolDecision> {
    let current = call.input;
    let modified = false;
    const context: string[] = [];
    for (const hook of this.matching("PreToolUse", call.tool)) {
      const result = await this.runHook(
        hook,
        { ...this.base("PreToolUse", call.agentId), tool_name: call.tool, tool_input: current },
        call.agentId,
      );
      if (!result) continue;
      if (result.decision === "deny") {
        return {
          decision: "deny",
          reason: result.reason || "A PreToolUse hook denied this call.",
          input: current,
          modified,
        };
      }
      if (result.updatedInput) {
        current = result.updatedInput;
        modified = true;
      }
      if (result.additionalContext) context.push(result.additionalContext);
    }
    return { decision: "allow", input: current, modified, ...(context.length ? { context: context.join("\n\n") } : {}) };
  }

  /** Feedback to append to the tool result, or null. */
  async postToolUse(call: {
    agentId: string;
    tool: string;
    input: Record<string, unknown>;
    output: string;
    failed: boolean;
  }): Promise<string | null> {
    const feedback: string[] = [];
    for (const hook of this.matching("PostToolUse", call.tool)) {
      const result = await this.runHook(
        hook,
        {
          ...this.base("PostToolUse", call.agentId),
          tool_name: call.tool,
          tool_input: call.input,
          tool_response: call.output.length > MAX_TOOL_RESPONSE ? call.output.slice(0, MAX_TOOL_RESPONSE) : call.output,
          tool_failed: call.failed,
        },
        call.agentId,
      );
      const text = result?.additionalContext ?? (result?.decision === "deny" ? result.reason : undefined);
      if (text) feedback.push(text);
    }
    return feedback.length ? feedback.join("\n\n") : null;
  }

  /** Context to add to the run's request, or null. */
  async sessionStart(info: { source: "agent" | "solve"; prompt: string }): Promise<string | null> {
    const context: string[] = [];
    for (const hook of this.matching("SessionStart")) {
      const result = await this.runHook(
        hook,
        { ...this.base("SessionStart"), source: info.source, prompt: info.prompt },
        SESSION_AGENT_ID,
      );
      if (result?.additionalContext) context.push(result.additionalContext);
    }
    return context.length ? context.join("\n\n") : null;
  }

  async userPromptSubmit(info: { prompt: string }): Promise<{ blocked: boolean; reason?: string; context?: string }> {
    const context: string[] = [];
    for (const hook of this.matching("UserPromptSubmit")) {
      const result = await this.runHook(
        hook,
        { ...this.base("UserPromptSubmit"), prompt: info.prompt },
        SESSION_AGENT_ID,
      );
      if (result?.decision === "deny") {
        return { blocked: true, reason: result.reason || "A UserPromptSubmit hook rejected this request." };
      }
      if (result?.additionalContext) context.push(result.additionalContext);
    }
    return { blocked: false, ...(context.length ? { context: context.join("\n\n") } : {}) };
  }

  /**
   * The agent is about to finish. A deny keeps it working with the reason
   * as feedback. The caller consults this only after the harness (the
   * gate) has allowed the finish, so a hook can add a requirement but can
   * never accept work the gate rejected.
   */
  async stop(info: { agentId: string; lastMessage: string; stopHookActive: boolean }): Promise<{ block: boolean; reason?: string }> {
    const reasons: string[] = [];
    for (const hook of this.matching("Stop")) {
      const result = await this.runHook(
        hook,
        { ...this.base("Stop", info.agentId), last_message: info.lastMessage.slice(0, 8_000), stop_hook_active: info.stopHookActive },
        info.agentId,
      );
      if (result?.decision === "deny") reasons.push(result.reason || "A Stop hook asked the agent to keep working.");
    }
    return reasons.length ? { block: true, reason: reasons.join("\n\n") } : { block: false };
  }
}

/* ------------------------------- loading --------------------------------- */

export interface HooksOverview {
  global: HooksFileRead | null;
  workspace:
    | (HooksFileRead & {
        /** "none" when there is no workspace hooks file. */
        trust: TrustState | "none";
        approvedAt: string | null;
      })
    | null;
  builtins: { name: string; event: HookEventName; matcher?: string }[];
  /** The command hooks that will actually run. */
  active: CommandHook[];
}

/**
 * Read both hooks files and resolve trust. `trustRoot` is the workspace the
 * trust decision belongs to when it differs from where the files are read
 * (a headless `--worktree` run reads a temporary checkout of the repo).
 */
export async function describeHooks(root: string | null, trustRoot?: string): Promise<HooksOverview> {
  const globalFile = globalHooksPath();
  const global = globalFile ? await readHooksFile(globalFile, "global") : null;
  let workspace: HooksOverview["workspace"] = null;
  if (root) {
    const read = await readHooksFile(workspaceHooksPath(root), "workspace");
    const trustAt = trustRoot ?? root;
    const trust: TrustState | "none" = read.exists ? await trustStateFor(trustAt, read.hash) : "none";
    const record = read.exists ? await getTrustRecord(trustAt) : null;
    workspace = { ...read, trust, approvedAt: record?.approvedAt ?? null };
  }
  const active = [...(global?.hooks ?? []), ...(workspace?.trust === "trusted" ? workspace.hooks : [])];
  return {
    global,
    workspace,
    builtins: registeredHooks().map((h) => ({ name: h.name, event: h.event, ...(h.matcher ? { matcher: h.matcher } : {}) })),
    active,
  };
}

export interface LoadHookEngineOptions extends Omit<HookEngineOptions, "hooks" | "cwd"> {
  root: string | null;
  trustRoot?: string;
}

/**
 * Build the engine for one run. Untrusted (or changed) workspace hooks are
 * left out, and that is reported once on the stream so the user knows why
 * their project hooks did not fire. A config that cannot be read never
 * fails the run.
 */
export async function loadHookEngine(options: LoadHookEngineOptions): Promise<HookEngine> {
  const overview = await describeHooks(options.root, options.trustRoot).catch(() => null);
  const engine = new HookEngine({ ...options, cwd: options.root, hooks: overview?.active ?? [] });
  const ws = overview?.workspace;
  if (ws?.exists && ws.trust !== "trusted" && ws.hooks.length) {
    const notice =
      ws.trust === "changed"
        ? `Workspace hooks changed since you approved them; ${ws.hooks.length} hook(s) skipped until you approve again (Settings → Hooks or \`viberon hooks trust\`).`
        : `Workspace hooks are not trusted; ${ws.hooks.length} hook(s) skipped. Review and approve them in Settings → Hooks or with \`viberon hooks trust\`.`;
    engine.notices.push(notice);
    options.emit?.({
      type: "hook",
      agentId: SESSION_AGENT_ID,
      event: "session_start",
      command: WORKSPACE_HOOKS_FILE,
      exitCode: null,
      blocked: false,
      output: notice,
      source: "workspace",
      outcome: "skipped",
    });
  }
  for (const file of [overview?.global, ws]) {
    if (file?.errors.length) engine.notices.push(`${file.path}: ${file.errors.join("; ")}`);
  }
  return engine;
}
