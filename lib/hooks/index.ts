/**
 * Pre/post-tool and lifecycle hooks. See docs/HOOKS.md.
 */

export * from "@/lib/hooks/types";
export { compileMatcher, matchesTool } from "@/lib/hooks/matcher";
export { normalizeHookResult, parseCommandRun, extractJson } from "@/lib/hooks/protocol";
export {
  configDir,
  globalHooksPath,
  hashHooksFile,
  parseHooksConfig,
  readHooksFile,
  workspaceHooksPath,
  WORKSPACE_HOOKS_FILE,
} from "@/lib/hooks/config";
export { revokeWorkspaceHooks, trustStateFor, trustWorkspaceHooks, workspaceId, type TrustState } from "@/lib/hooks/trust";
export { runHookCommand, type HookExecutor } from "@/lib/hooks/exec";
export {
  describeHooks,
  HookEngine,
  loadHookEngine,
  recentHookRuns,
  registerHook,
  registeredHooks,
  SESSION_AGENT_ID,
  type HooksOverview,
  type PreToolDecision,
} from "@/lib/hooks/engine";
