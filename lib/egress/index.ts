/**
 * Network egress control: one policy for every way Viberon reaches the
 * network. See docs/EGRESS.md.
 *
 *   policy.ts   modes, rules, presets, merging, the per-host decision
 *   fetch.ts    policy-checked fetch with per-hop redirect checks + SSRF guard (browse)
 *   command.ts  best-effort network intent in shell commands (terminal)
 *   sandbox.ts  Docker network settings derived from the policy
 *   proxy.ts    the policy-enforcing HTTP/CONNECT proxy for spawned processes
 *   audit.ts    append-only JSONL log at <workspace>/.viberon/egress.log
 *   settings.ts global + per-workspace storage
 *
 * This file adds the two helpers callers use around process execution.
 */

import { auditCommandEgress, evaluateCommandEgress, gitRemoteResolver, type CommandEgressVerdict } from "./command";
import { appendAudit, redactUrl } from "./audit";
import { targetFromUrl } from "./host";
import { classifyIp, parseIp } from "./ip";
import { evaluateHost, type EffectiveEgressPolicy, type EgressSource } from "./policy";
import { sharedEgressProxy } from "./proxy";
import { applySandboxPlan, deriveSandboxNetwork, type SandboxNetworkMode, type SandboxNetworkPlan } from "./sandbox";
import { loadEffectivePolicy } from "./settings";

export * from "./policy";
export * from "./presets";
export { checkUrl, decideHost, egressFetch, systemLookup, type EgressScope, type Lookup, type UrlCheck } from "./fetch";
export { appendAudit, auditLogPath, readAudit, redactUrl, type EgressAuditEntry } from "./audit";
export { auditCommandEgress, describeFinding, evaluateCommandEgress, findNetworkIntents, gitRemoteResolver } from "./command";
export type { CommandEgressVerdict, CommandEgressFinding, NetworkIntent } from "./command";
export { applySandboxPlan, deriveSandboxNetwork, stricterNetwork, type SandboxNetworkPlan } from "./sandbox";
export { loadEffectivePolicy, getGlobalPolicy, getWorkspacePolicy, setGlobalPolicy, setWorkspacePolicy } from "./settings";

export interface WorkspaceRef {
  repoKey: string;
  rootPath: string | null;
}

/**
 * Check a shell command's network intent against the workspace policy and
 * log the findings. Callers turn "block" into a refusal and "ask" into a
 * forced approval (see the run_command tool).
 */
export async function checkCommandEgress(
  command: string,
  where: WorkspaceRef & { policy?: EffectiveEgressPolicy; source?: EgressSource; audit?: boolean },
): Promise<{ verdict: CommandEgressVerdict; policy: EffectiveEgressPolicy }> {
  const policy = where.policy ?? (await loadEffectivePolicy(where.repoKey));
  const verdict = evaluateCommandEgress(command, policy, {
    gitRemoteUrl: gitRemoteResolver(where.rootPath),
    source: where.source,
  });
  // "ask" findings are logged once the approval is settled, by the caller.
  if (where.audit !== false && verdict.findings.length && verdict.action !== "ask") {
    await auditCommandEgress(verdict, { ...where, command });
  }
  return { verdict, policy };
}

type SandboxLike = { enabled: boolean; network?: SandboxNetworkMode; allowedDomains?: string[] };

export type PreparedEgress<T extends SandboxLike> =
  | {
      ok: true;
      policy: EffectiveEgressPolicy;
      plan: SandboxNetworkPlan;
      sandbox: T | undefined;
      egressProxy: { hostUrl?: string; containerUrl?: string } | undefined;
    }
  | { ok: false; error: string };

/**
 * Network settings for a process Viberon is about to spawn:
 *  - the sandbox config with its network derived from the policy;
 *  - proxy URLs when the policy restricts anything, for direct execution
 *    (127.0.0.1) and for the container (host.docker.internal).
 * Fails closed: if the proxy is needed and cannot start, the caller must
 * not run the command.
 */
export async function prepareProcessEgress<T extends SandboxLike>(
  where: WorkspaceRef & { sandbox?: T; policy?: EffectiveEgressPolicy; approvedHosts?: string[] },
): Promise<PreparedEgress<T>> {
  const policy = where.policy ?? (await loadEffectivePolicy(where.repoKey));
  const plan = deriveSandboxNetwork(policy);
  const sandbox = where.sandbox?.enabled ? (applySandboxPlan(where.sandbox, plan) as T) : where.sandbox;
  const restrictive = policy.mode !== "open" || policy.rules.some((r) => r.action === "deny");
  const wantContainer = Boolean(sandbox?.enabled && plan.useProxy);
  if (!restrictive && !wantContainer) {
    return { ok: true, policy, plan, sandbox, egressProxy: undefined };
  }
  try {
    const proxy = await sharedEgressProxy();
    const allowHosts = where.approvedHosts?.length ? where.approvedHosts : undefined;
    return {
      ok: true,
      policy,
      plan,
      sandbox,
      egressProxy: {
        hostUrl: restrictive ? proxy.urlFor({ repoKey: where.repoKey, rootPath: where.rootPath, source: "terminal", allowHosts }) : undefined,
        containerUrl: wantContainer
          ? proxy.urlFor({ repoKey: where.repoKey, rootPath: where.rootPath, source: "sandbox", allowHosts }, "host.docker.internal")
          : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `the egress proxy could not start (${error instanceof Error ? error.message : String(error)}), so the network policy cannot be enforced`,
    };
  }
}

/**
 * Check a configured service endpoint (a remote MCP server) before
 * connecting. Host rules and mode apply; this machine is always reachable
 * (local MCP servers); there is no DNS/SSRF step because the URL comes from
 * configuration the user enabled, not from the model. Logged either way.
 */
export async function checkServiceUrl(
  url: string | URL,
  where: WorkspaceRef & { source: EgressSource; policy?: EffectiveEgressPolicy },
): Promise<{ allowed: boolean; reason: string; rule: string }> {
  const target = targetFromUrl(url);
  if (!target) return { allowed: false, reason: `"${String(url)}" is not a valid URL`, rule: "invalid-url" };
  const ip = parseIp(target.host);
  if (target.host === "localhost" || target.host.endsWith(".localhost") || (ip && classifyIp(ip) === "loopback")) {
    return { allowed: true, reason: `${target.host} is this machine`, rule: "local" };
  }
  const policy = where.policy ?? (await loadEffectivePolicy(where.repoKey));
  const decision = evaluateHost(policy, target.host, target.port, where.source);
  await appendAudit(where.rootPath, {
    host: decision.host,
    port: target.port,
    decision: decision.allowed ? "allow" : "deny",
    source: where.source,
    rule: decision.rule,
    reason: decision.reason,
    url: redactUrl(url),
    repoKey: where.repoKey || undefined,
  });
  return { allowed: decision.allowed, reason: decision.reason, rule: decision.rule };
}
