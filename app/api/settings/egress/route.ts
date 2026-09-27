/**
 * Network egress policy.
 *
 *   GET  /api/settings/egress?repoKey=…   → global + workspace policy, the effective
 *                                           merge, implicit provider hosts, presets,
 *                                           and the derived sandbox network plan
 *   PUT  /api/settings/egress             → { scope: "global", policy }
 *                                           { scope: "workspace", repoKey, policy | null }
 *   POST /api/settings/egress             → { action: "test", repoKey, url? | command? }
 *                                           dry-run a decision (not logged)
 *
 * The audit log is read through /api/settings/egress/log.
 */

import {
  EGRESS_PRESETS,
  checkUrl,
  deriveSandboxNetwork,
  describeFinding,
  evaluateCommandEgress,
  getGlobalPolicy,
  getWorkspacePolicy,
  gitRemoteResolver,
  loadEffectivePolicy,
  ruleLabel,
  sanitizePolicy,
  sanitizeWorkspacePolicy,
  setGlobalPolicy,
  setWorkspacePolicy,
  type EffectiveEgressPolicy,
} from "@/lib/egress";
import { auditLogPath } from "@/lib/egress/audit";
import { providerHostsInUse } from "@/lib/egress/providers";
import { envMode } from "@/lib/egress/settings";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

async function rootPathFor(repoKey: string): Promise<string | null> {
  if (!repoKey) return null;
  const handle = await openWorkspace(repoKey).catch(() => null);
  return handle?.rootPath ?? null;
}

function describeEffective(policy: EffectiveEgressPolicy) {
  return {
    mode: policy.mode,
    modeFrom: policy.modeFrom,
    presets: policy.presets,
    offPolicyCommands: policy.offPolicyCommands,
    rules: policy.rules.map((r) => ({
      action: r.action,
      pattern: r.pattern.source,
      origin: r.origin,
      note: r.note,
      label: ruleLabel(r),
    })),
    invalid: policy.invalid,
  };
}

async function snapshot(repoKey: string) {
  const [global, workspace, effective, providers, rootPath] = await Promise.all([
    getGlobalPolicy(),
    getWorkspacePolicy(repoKey),
    loadEffectivePolicy(repoKey),
    providerHostsInUse(),
    rootPathFor(repoKey),
  ]);
  return {
    global,
    workspace,
    effective: describeEffective(effective),
    providerHosts: providers,
    presets: EGRESS_PRESETS,
    sandbox: deriveSandboxNetwork(effective),
    envMode: envMode(),
    logPath: auditLogPath(rootPath),
    hasFolder: Boolean(rootPath),
  };
}

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey") ?? "";
  return Response.json(await snapshot(repoKey));
}

export async function PUT(request: Request) {
  let body: { scope?: unknown; repoKey?: unknown; policy?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Body must be valid JSON");
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";

  if (body.scope === "global") {
    const result = sanitizePolicy(body.policy);
    if ("errors" in result) return bad(result.errors.join("; "));
    await setGlobalPolicy(result.policy);
  } else if (body.scope === "workspace") {
    if (!repoKey) return bad("repoKey is required for a workspace policy");
    if (body.policy === null) {
      await setWorkspacePolicy(repoKey, null);
    } else {
      const result = sanitizeWorkspacePolicy(body.policy);
      if ("errors" in result) return bad(result.errors.join("; "));
      await setWorkspacePolicy(repoKey, result.policy);
    }
  } else {
    return bad('scope must be "global" or "workspace"');
  }
  return Response.json({ ok: true, ...(await snapshot(repoKey)) });
}

export async function POST(request: Request) {
  let body: { action?: unknown; repoKey?: unknown; url?: unknown; command?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Body must be valid JSON");
  }
  if (body.action !== "test") return bad('action must be "test"');
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const policy = await loadEffectivePolicy(repoKey);

  if (typeof body.command === "string" && body.command.trim()) {
    const rootPath = await rootPathFor(repoKey);
    const verdict = evaluateCommandEgress(body.command.trim(), policy, { gitRemoteUrl: gitRemoteResolver(rootPath) });
    return Response.json({
      kind: "command",
      action: verdict.action,
      reason: verdict.reason,
      findings: verdict.findings.map((f) => ({ target: describeFinding(f), action: f.action, rule: f.rule, reason: f.reason })),
    });
  }

  if (typeof body.url === "string" && body.url.trim()) {
    let raw = body.url.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
    const check = await checkUrl(raw, { policy, source: "browse", audit: false });
    return Response.json({ kind: "url", ...check });
  }
  return bad("url or command is required");
}
