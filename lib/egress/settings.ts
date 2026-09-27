/**
 * Where egress policies live: the same server-side settings store as
 * provider keys and MCP servers.
 *
 *   egress:global              → EgressPolicy
 *   egress:workspace:<repoKey> → WorkspaceEgressPolicy (absent = inherit all)
 *
 * `VIBERON_EGRESS_MODE` (open | allowlist | deny) pins the mode for a whole
 * process — headless and CI runs use it (the CLI's `--egress` flag sets it)
 * — and wins over both stored scopes.
 */

import {
  DEFAULT_EGRESS_POLICY,
  EGRESS_MODES,
  resolvePolicy,
  type EffectiveEgressPolicy,
  type EgressMode,
  type EgressPolicy,
  type WorkspaceEgressPolicy,
} from "./policy";
import { providerHostsInUse } from "./providers";

const GLOBAL_KEY = "egress:global";
const workspaceKey = (repoKey: string) => `egress:workspace:${repoKey}`;

type StoreModule = typeof import("@/lib/store");
let storePromise: Promise<StoreModule> | null = null;
function store(): Promise<StoreModule> {
  if (!storePromise) storePromise = import("@/lib/store");
  return storePromise;
}

export async function getGlobalPolicy(): Promise<EgressPolicy> {
  try {
    const { getValueRaw } = await store();
    const saved = await getValueRaw<EgressPolicy>(GLOBAL_KEY);
    return saved ? { ...DEFAULT_EGRESS_POLICY, ...saved } : DEFAULT_EGRESS_POLICY;
  } catch {
    return DEFAULT_EGRESS_POLICY;
  }
}

export async function setGlobalPolicy(policy: EgressPolicy | null): Promise<void> {
  const { setValueRaw } = await store();
  await setValueRaw(GLOBAL_KEY, policy);
}

export async function getWorkspacePolicy(repoKey: string): Promise<WorkspaceEgressPolicy | null> {
  if (!repoKey) return null;
  try {
    const { getValueRaw } = await store();
    return await getValueRaw<WorkspaceEgressPolicy>(workspaceKey(repoKey));
  } catch {
    return null;
  }
}

export async function setWorkspacePolicy(repoKey: string, policy: WorkspaceEgressPolicy | null): Promise<void> {
  const { setValueRaw } = await store();
  await setValueRaw(workspaceKey(repoKey), policy);
}

/** Mode forced by the environment, if any. */
export function envMode(): EgressMode | null {
  const raw = (process.env.VIBERON_EGRESS_MODE ?? "").trim().toLowerCase();
  return EGRESS_MODES.includes(raw as EgressMode) ? (raw as EgressMode) : null;
}

/** The policy in force for a workspace ("" = no workspace: global only). */
export async function loadEffectivePolicy(repoKey: string): Promise<EffectiveEgressPolicy> {
  const [global, workspace, providers] = await Promise.all([
    getGlobalPolicy(),
    getWorkspacePolicy(repoKey),
    providerHostsInUse(),
  ]);
  const effective = resolvePolicy(global, workspace, providers.map((p) => p.host));
  const forced = envMode();
  if (forced) {
    effective.mode = forced;
    effective.modeFrom = "env";
  }
  return effective;
}
