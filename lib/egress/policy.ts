/**
 * The egress policy: data model, validation, global/workspace merging and
 * the per-destination decision.
 *
 * Pure (no fs, no network), so every subsystem — browse, terminal, sandbox,
 * MCP, the proxy — asks the same question and gets the same answer, and the
 * settings UI can import the types.
 *
 * Decision order for one destination:
 *
 *   1. the harness's own model-provider traffic → allow (implicit)
 *   2. a matching deny rule, from any scope      → deny   (deny beats allow)
 *   3. mode "deny"                               → deny
 *   4. a matching user allow rule                → allow
 *   5. mode "allowlist": an enabled preset       → allow, otherwise deny
 *   6. mode "open"                               → allow
 *
 * Separately, `checkAddress` guards the *resolved* IP (SSRF): private,
 * loopback, link-local and metadata addresses need an explicit user rule.
 */

import { classifyIp, type AddressClass, type ParsedIp, parseIp } from "./ip";
import { EGRESS_PRESETS, isPresetId, type EgressPresetId } from "./presets";
import { matchAddress, matchPattern, parsePattern, type HostPattern, type PatternKind } from "./rules";
import { formatTarget, normalizeHost } from "./host";

export type EgressMode = "open" | "allowlist" | "deny";
export const EGRESS_MODES: EgressMode[] = ["open", "allowlist", "deny"];

/** Which part of Viberon wants to reach the network. */
export type EgressSource = "browse" | "terminal" | "sandbox" | "mcp" | "provider" | "proxy";

export type EgressAction = "allow" | "deny";

export interface EgressRule {
  action: EgressAction;
  pattern: string;
  /** Free-text reason, shown in the UI and the audit log. */
  note?: string;
}

/** What to do with a shell command that reaches an off-policy host. */
export type OffPolicyCommands = "ask" | "block";

export interface EgressPolicy {
  mode: EgressMode;
  /** Presets are consulted in allowlist mode only. */
  presets: EgressPresetId[];
  rules: EgressRule[];
  offPolicyCommands: OffPolicyCommands;
}

/** A workspace override: unset fields inherit from the global policy. */
export interface WorkspaceEgressPolicy {
  mode?: EgressMode;
  presets?: EgressPresetId[];
  rules: EgressRule[];
  offPolicyCommands?: OffPolicyCommands;
}

/**
 * Open by default: installing the app must not silently break `npm install`.
 * The presets are pre-selected so switching to allowlist is one click.
 */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  mode: "open",
  presets: ["packageRegistries", "docs", "gitHosts"],
  rules: [],
  offPolicyCommands: "ask",
};

/** "approval": a host a person approved for one command (see `withApprovedHosts`). */
export type RuleOrigin = "global" | "workspace" | "preset" | "provider" | "approval";

export interface CompiledRule {
  action: EgressAction;
  pattern: HostPattern;
  origin: RuleOrigin;
  /** Preset id for preset rules. */
  presetId?: EgressPresetId;
  note?: string;
}

export interface EffectiveEgressPolicy {
  mode: EgressMode;
  /** Where the mode came from, for the UI. */
  modeFrom: "global" | "workspace" | "env";
  presets: EgressPresetId[];
  offPolicyCommands: OffPolicyCommands;
  /** User rules (global first, then workspace). */
  rules: CompiledRule[];
  /** Hosts of the model providers in use; implicitly allowed for the harness. */
  providerHosts: string[];
  /** Rules that failed to parse; skipped, surfaced in the UI. */
  invalid: { pattern: string; error: string; origin: RuleOrigin }[];
}

export interface EgressDecision {
  allowed: boolean;
  host: string;
  port: number | null;
  /** Human-readable name of the rule that decided, e.g. `deny *.evil.test (workspace)`. */
  rule: string;
  /** One sentence for refusals and the log. */
  reason: string;
  /** The allow came from a user rule naming this host (not a preset or the open mode). */
  explicit: boolean;
  /** Kind of the user allow rule that matched, when one did. */
  matchedKind?: PatternKind;
}

/* ------------------------------ validation -------------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function sanitizeRules(input: unknown): { rules: EgressRule[]; errors: string[] } {
  const rules: EgressRule[] = [];
  const errors: string[] = [];
  if (input === undefined) return { rules, errors };
  if (!Array.isArray(input)) return { rules, errors: ["rules must be an array"] };
  if (input.length > 500) errors.push("at most 500 rules");
  for (const raw of input.slice(0, 500)) {
    if (!isRecord(raw)) {
      errors.push("each rule must be an object");
      continue;
    }
    const action = raw.action === "deny" ? "deny" : raw.action === "allow" ? "allow" : null;
    const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
    if (!action) {
      errors.push(`rule "${pattern}": action must be "allow" or "deny"`);
      continue;
    }
    const parsed = parsePattern(pattern);
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 200) : undefined;
    rules.push(note ? { action, pattern, note } : { action, pattern });
  }
  return { rules, errors };
}

function sanitizePresets(input: unknown, errors: string[]): EgressPresetId[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    errors.push("presets must be an array");
    return undefined;
  }
  const out: EgressPresetId[] = [];
  for (const p of input) {
    if (isPresetId(p)) {
      if (!out.includes(p)) out.push(p);
    } else errors.push(`unknown preset "${String(p)}"`);
  }
  return out;
}

/** Validate a global policy from untrusted input. */
export function sanitizePolicy(input: unknown): { policy: EgressPolicy } | { errors: string[] } {
  if (!isRecord(input)) return { errors: ["policy must be an object"] };
  const errors: string[] = [];
  const mode = EGRESS_MODES.includes(input.mode as EgressMode) ? (input.mode as EgressMode) : null;
  if (!mode) errors.push(`mode must be one of ${EGRESS_MODES.join(", ")}`);
  const presets = sanitizePresets(input.presets, errors) ?? DEFAULT_EGRESS_POLICY.presets;
  const { rules, errors: ruleErrors } = sanitizeRules(input.rules);
  errors.push(...ruleErrors);
  const off = input.offPolicyCommands === undefined ? "ask" : input.offPolicyCommands;
  if (off !== "ask" && off !== "block") errors.push('offPolicyCommands must be "ask" or "block"');
  if (errors.length) return { errors };
  return { policy: { mode: mode as EgressMode, presets, rules, offPolicyCommands: off as OffPolicyCommands } };
}

/** Validate a workspace override; `null`/`"inherit"` fields inherit. */
export function sanitizeWorkspacePolicy(
  input: unknown,
): { policy: WorkspaceEgressPolicy } | { errors: string[] } {
  if (!isRecord(input)) return { errors: ["policy must be an object"] };
  const errors: string[] = [];
  const out: WorkspaceEgressPolicy = { rules: [] };
  if (input.mode !== undefined && input.mode !== null && input.mode !== "inherit") {
    if (EGRESS_MODES.includes(input.mode as EgressMode)) out.mode = input.mode as EgressMode;
    else errors.push(`mode must be one of ${EGRESS_MODES.join(", ")} or "inherit"`);
  }
  if (input.presets !== null) {
    const presets = sanitizePresets(input.presets, errors);
    if (presets) out.presets = presets;
  }
  const { rules, errors: ruleErrors } = sanitizeRules(input.rules);
  errors.push(...ruleErrors);
  out.rules = rules;
  const off = input.offPolicyCommands;
  if (off !== undefined && off !== null && off !== "inherit") {
    if (off === "ask" || off === "block") out.offPolicyCommands = off;
    else errors.push('offPolicyCommands must be "ask", "block" or "inherit"');
  }
  if (errors.length) return { errors };
  return { policy: out };
}

/* -------------------------------- merging --------------------------------- */

function compile(
  rules: EgressRule[],
  origin: RuleOrigin,
  invalid: EffectiveEgressPolicy["invalid"],
): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of rules) {
    const pattern = parsePattern(rule.pattern);
    if (typeof pattern === "string") {
      invalid.push({ pattern: rule.pattern, error: pattern, origin });
      continue;
    }
    out.push({ action: rule.action, pattern, origin, note: rule.note });
  }
  return out;
}

/**
 * Combine the global policy and a workspace override. The workspace wins on
 * mode, presets and the off-policy command setting; rules from both scopes
 * apply together, and a deny from either scope beats an allow from either —
 * so a workspace can narrow what an administrator allowed globally, but
 * cannot re-open a host the global policy denies.
 */
export function resolvePolicy(
  global: EgressPolicy | null,
  workspace: WorkspaceEgressPolicy | null,
  providerHosts: string[] = [],
): EffectiveEgressPolicy {
  const g = global ?? DEFAULT_EGRESS_POLICY;
  const invalid: EffectiveEgressPolicy["invalid"] = [];
  const rules = [
    ...compile(g.rules, "global", invalid),
    ...compile(workspace?.rules ?? [], "workspace", invalid),
  ];
  const hosts = new Set<string>();
  for (const h of providerHosts) {
    const n = normalizeHost(h);
    if (n) hosts.add(n);
  }
  return {
    mode: workspace?.mode ?? g.mode,
    modeFrom: workspace?.mode ? "workspace" : "global",
    presets: workspace?.presets ?? g.presets,
    offPolicyCommands: workspace?.offPolicyCommands ?? g.offPolicyCommands,
    rules,
    providerHosts: [...hosts],
    invalid,
  };
}

/**
 * The policy plus allow rules for hosts a person approved for one command.
 * Deny rules and mode "deny" still win; the approval only lifts "not on the
 * allowlist".
 */
export function withApprovedHosts(policy: EffectiveEgressPolicy, hosts: string[]): EffectiveEgressPolicy {
  const extra: CompiledRule[] = [];
  for (const host of hosts) {
    const pattern = parsePattern(host);
    if (typeof pattern !== "string" && pattern.kind !== "any") extra.push({ action: "allow", pattern, origin: "approval" });
  }
  return extra.length ? { ...policy, rules: [...policy.rules, ...extra] } : policy;
}

let presetCache: Map<EgressPresetId, CompiledRule[]> | null = null;
function presetRules(id: EgressPresetId): CompiledRule[] {
  if (!presetCache) {
    presetCache = new Map();
    for (const preset of EGRESS_PRESETS) {
      const compiled: CompiledRule[] = [];
      for (const host of preset.hosts) {
        const pattern = parsePattern(host);
        if (typeof pattern !== "string") {
          compiled.push({ action: "allow", pattern, origin: "preset", presetId: preset.id });
        }
      }
      presetCache.set(preset.id, compiled);
    }
  }
  return presetCache.get(id) ?? [];
}

export function ruleLabel(rule: CompiledRule): string {
  if (rule.origin === "preset") return `preset:${rule.presetId} (${rule.pattern.source})`;
  return `${rule.action} ${rule.pattern.source} (${rule.origin})`;
}

/* -------------------------------- deciding -------------------------------- */

/**
 * Decide one destination by name. `host` may be un-normalized; an invalid
 * host is denied.
 */
export function evaluateHost(
  policy: EffectiveEgressPolicy,
  rawHost: string,
  port: number | null,
  source: EgressSource,
): EgressDecision {
  const host = normalizeHost(rawHost);
  const where = formatTarget(host ?? rawHost, port);
  if (!host) {
    return { allowed: false, host: rawHost, port, rule: "invalid-host", reason: `"${rawHost}" is not a valid host`, explicit: false };
  }
  const base = { host, port };

  if (source === "provider" && policy.providerHosts.includes(host)) {
    return { ...base, allowed: true, rule: "implicit:provider", reason: `${where} is a configured model provider`, explicit: true };
  }

  const deny = policy.rules.find((r) => r.action === "deny" && matchPattern(r.pattern, host, port));
  if (deny) {
    return { ...base, allowed: false, rule: ruleLabel(deny), reason: `${where} is denied by rule "${deny.pattern.source}"`, explicit: false };
  }

  if (policy.mode === "deny") {
    return { ...base, allowed: false, rule: "mode:deny", reason: `network egress is disabled (mode "deny"), so ${where} is blocked`, explicit: false };
  }

  const allow = policy.rules.find((r) => r.action === "allow" && matchPattern(r.pattern, host, port));
  if (allow) {
    return {
      ...base,
      allowed: true,
      rule: ruleLabel(allow),
      reason: `${where} is allowed by rule "${allow.pattern.source}"`,
      // `*` is a blanket allow, not a decision about this particular host.
      explicit: allow.pattern.kind !== "any",
      matchedKind: allow.pattern.kind,
    };
  }

  if (policy.mode === "allowlist") {
    for (const id of policy.presets) {
      const hit = presetRules(id).find((r) => matchPattern(r.pattern, host, port));
      if (hit) {
        return { ...base, allowed: true, rule: ruleLabel(hit), reason: `${where} is in the "${id}" preset`, explicit: false };
      }
    }
    return { ...base, allowed: false, rule: "mode:allowlist", reason: `${where} is not on the egress allowlist`, explicit: false };
  }

  return { ...base, allowed: true, rule: "mode:open", reason: `${where} is allowed (mode "open")`, explicit: false };
}

export interface AddressCheck {
  allowed: boolean;
  address: string;
  addressClass: AddressClass;
  rule: string | null;
  reason: string;
}

/**
 * SSRF guard for one resolved address of an already-allowed host.
 *
 * - Deny rules written as IPs/CIDRs apply to resolved addresses too.
 * - Public addresses pass.
 * - Loopback, private and link-local addresses pass only when a user allow
 *   rule names the host (exact or wildcard) or covers the address (IP/CIDR).
 * - Metadata endpoints pass only with an allow rule for that exact IP.
 */
export function checkAddress(
  policy: EffectiveEgressPolicy,
  hostDecision: EgressDecision,
  address: string,
  port: number | null,
): AddressCheck {
  const ip: ParsedIp | null = parseIp(address);
  if (!ip) {
    return { allowed: false, address, addressClass: "reserved", rule: "invalid-address", reason: `resolver returned an invalid address "${address}"` };
  }
  const addressClass = classifyIp(ip);
  const deny = policy.rules.find((r) => r.action === "deny" && matchAddress(r.pattern, ip, port));
  if (deny) {
    return { allowed: false, address, addressClass, rule: ruleLabel(deny), reason: `${address} is denied by rule "${deny.pattern.source}"` };
  }
  if (addressClass === "public") {
    return { allowed: true, address, addressClass, rule: null, reason: "public address" };
  }

  const userAllows = policy.rules.filter((r) => r.action === "allow" && (r.origin === "global" || r.origin === "workspace"));
  if (addressClass === "metadata") {
    const exact = userAllows.find((r) => r.pattern.kind === "ip" && matchAddress(r.pattern, ip, port));
    if (exact) return { allowed: true, address, addressClass, rule: ruleLabel(exact), reason: "metadata address explicitly allowed" };
    return {
      allowed: false,
      address,
      addressClass,
      rule: "ssrf:metadata",
      reason: `${hostDecision.host} resolves to the cloud metadata address ${address}; allowing it needs a rule for that exact IP`,
    };
  }

  const byAddress = userAllows.find((r) => matchAddress(r.pattern, ip, port));
  if (byAddress) {
    return { allowed: true, address, addressClass, rule: ruleLabel(byAddress), reason: `${addressClass} address explicitly allowed` };
  }
  if (hostDecision.explicit && hostDecision.rule !== "implicit:provider") {
    return { allowed: true, address, addressClass, rule: hostDecision.rule, reason: `${addressClass} address of an explicitly allowed host` };
  }
  return {
    allowed: false,
    address,
    addressClass,
    rule: `ssrf:${addressClass}`,
    reason: `${hostDecision.host} resolves to the ${addressClass} address ${address}; add an allow rule for the host or address to permit it`,
  };
}
