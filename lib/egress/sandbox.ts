/**
 * Docker sandbox network settings derived from the egress policy.
 *
 * Docker itself cannot filter by hostname, so the mapping is:
 *
 *   deny       → `--network none`: no interface but loopback. Hard boundary.
 *   allowlist  → a bridge network plus HTTP(S)_PROXY pointing at the egress
 *                proxy, which applies the policy per CONNECT. Tools that
 *                honour proxy variables (npm, pip, cargo, go, git, curl,
 *                wget …) are held to the allowlist; a process that opens
 *                raw sockets and ignores the proxy is not. See docs/EGRESS.md.
 *   open       → a bridge network; the proxy is added only when there are
 *                deny rules to enforce.
 *
 * An explicit sandbox `network` setting can only make this stricter.
 */

import { EGRESS_PRESETS } from "./presets";
import type { EffectiveEgressPolicy } from "./policy";

export type SandboxNetworkMode = "none" | "host" | "bridge" | "restricted";

export interface SandboxNetworkPlan {
  network: "none" | "bridge";
  /** Route HTTP(S) through the egress proxy. */
  useProxy: boolean;
  /** Patterns the policy allows (display and `SandboxConfig.allowedDomains`); empty = unrestricted. */
  allowedDomains: string[];
  reason: string;
}

export function deriveSandboxNetwork(policy: EffectiveEgressPolicy): SandboxNetworkPlan {
  if (policy.mode === "deny") {
    return { network: "none", useProxy: false, allowedDomains: [], reason: "egress mode is deny: the container has no network" };
  }
  if (policy.mode === "allowlist") {
    const allowed = new Set<string>();
    for (const rule of policy.rules) if (rule.action === "allow") allowed.add(rule.pattern.source);
    for (const preset of EGRESS_PRESETS) {
      if (policy.presets.includes(preset.id)) for (const host of preset.hosts) allowed.add(host);
    }
    return {
      network: "bridge",
      useProxy: true,
      allowedDomains: [...allowed],
      reason: `egress mode is allowlist: HTTP(S) goes through the egress proxy (${allowed.size} allowed patterns)`,
    };
  }
  const hasDeny = policy.rules.some((r) => r.action === "deny");
  return {
    network: "bridge",
    useProxy: hasDeny,
    allowedDomains: [],
    reason: hasDeny
      ? "egress mode is open with deny rules: HTTP(S) goes through the egress proxy"
      : "egress mode is open",
  };
}

const STRICTNESS: Record<SandboxNetworkMode, number> = { none: 0, restricted: 1, bridge: 2, host: 3 };

/** The stricter of two network settings. */
export function stricterNetwork(a: SandboxNetworkMode | undefined, b: SandboxNetworkMode): SandboxNetworkMode {
  if (!a) return b;
  return STRICTNESS[a] <= STRICTNESS[b] ? a : b;
}

/**
 * Apply a plan to a sandbox config. Returns the config to start the
 * container with; `useProxy` tells the caller to inject proxy variables.
 */
export function applySandboxPlan<T extends { network?: SandboxNetworkMode; allowedDomains?: string[] }>(
  config: T,
  plan: SandboxNetworkPlan,
): T & { network: SandboxNetworkMode; allowedDomains: string[] } {
  const network = stricterNetwork(config.network, plan.network);
  return {
    ...config,
    network,
    allowedDomains: plan.allowedDomains.length ? plan.allowedDomains : (config.allowedDomains ?? []),
  };
}
