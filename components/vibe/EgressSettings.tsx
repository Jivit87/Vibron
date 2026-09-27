"use client";

/**
 * Settings rows for network egress control: mode, presets, allow/deny rules
 * (for all workspaces or just this one), the model hosts that are always
 * reachable, a dry-run tester, and the recent decisions from the audit log.
 * Everything round-trips through /api/settings/egress.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { useViberon } from "@/store/viberon";
import { Checkbox, cx, formatAgo, Segmented, SettingRow as Row } from "@/components/vibe/primitives";
import type {
  EgressAction,
  EgressMode,
  EgressPolicy,
  EgressRule,
  OffPolicyCommands,
  WorkspaceEgressPolicy,
} from "@/lib/egress/policy";
import type { EgressPreset, EgressPresetId } from "@/lib/egress/presets";

interface Snapshot {
  global: EgressPolicy;
  workspace: WorkspaceEgressPolicy | null;
  effective: {
    mode: EgressMode;
    modeFrom: "global" | "workspace" | "env";
    presets: EgressPresetId[];
    offPolicyCommands: OffPolicyCommands;
    rules: { action: EgressAction; pattern: string; origin: string; note?: string }[];
    invalid: { pattern: string; error: string; origin: string }[];
  };
  providerHosts: { provider: string; host: string; baseUrl: string }[];
  presets: EgressPreset[];
  sandbox: { network: string; useProxy: boolean; reason: string };
  envMode: EgressMode | null;
  logPath: string;
  hasFolder: boolean;
}

interface AuditEntry {
  ts: string;
  host: string;
  port: number | null;
  decision: "allow" | "deny" | "ask";
  source: string;
  rule: string | null;
  reason?: string;
  url?: string;
  command?: string;
}

type Scope = "global" | "workspace";
type Inheritable<T extends string> = T | "inherit";

interface Draft {
  mode: Inheritable<EgressMode>;
  presets: EgressPresetId[] | null;
  offPolicyCommands: Inheritable<OffPolicyCommands>;
  rules: EgressRule[];
}

const MODE_HINT: Record<EgressMode, string> = {
  open: "Everything is reachable except hosts you deny. Agent-driven fetches still refuse private and metadata addresses.",
  allowlist: "Only the presets and hosts you allow. Commands that reach anything else ask first, or are blocked.",
  deny: "No egress at all. The sandbox gets no network. Only your model provider stays reachable.",
};

function draftFrom(snapshot: Snapshot, scope: Scope): Draft {
  if (scope === "global") {
    const g = snapshot.global;
    return { mode: g.mode, presets: g.presets, offPolicyCommands: g.offPolicyCommands, rules: g.rules };
  }
  const w = snapshot.workspace;
  return {
    mode: w?.mode ?? "inherit",
    presets: w?.presets ?? null,
    offPolicyCommands: w?.offPolicyCommands ?? "inherit",
    rules: w?.rules ?? [],
  };
}

export function EgressSettings({ show }: { show: (text: string) => boolean }) {
  const repoKey = useViberon((s) => s.repoKey);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scope, setScope] = useState<Scope>("global");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [newAction, setNewAction] = useState<EgressAction>("allow");
  const [newPattern, setNewPattern] = useState("");
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const adopt = useCallback((next: Snapshot, nextScope: Scope) => {
    setSnapshot(next);
    setDraft(draftFrom(next, nextScope));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/settings/egress?repoKey=${encodeURIComponent(repoKey)}`);
      if (response.ok) adopt((await response.json()) as Snapshot, scope);
    } catch {
      // Server unreachable; the section shows its loading state.
    }
  }, [repoKey, scope, adopt]);

  const refreshLog = useCallback(async () => {
    try {
      const params = new URLSearchParams({ repoKey, limit: "50" });
      if (deniedOnly) params.set("decision", "deny");
      const response = await fetch(`/api/settings/egress/log?${params}`);
      if (response.ok) setLog(((await response.json()) as { entries: AuditEntry[] }).entries);
    } catch {
      setLog([]);
    }
  }, [repoKey, deniedOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshLog();
  }, [refreshLog]);

  const dirty = useMemo(
    () => Boolean(snapshot && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(snapshot, scope))),
    [snapshot, draft, scope],
  );

  if (!show("network egress allowlist deny proxy firewall domains hosts audit")) return null;

  if (!snapshot || !draft) {
    return (
      <p className="flex items-center gap-2 py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        <Loader2 className="size-3.5 animate-spin" />
        Loading network policy
      </p>
    );
  }

  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  function switchScope(next: Scope) {
    if (!snapshot) return;
    setScope(next);
    setDraft(draftFrom(snapshot, next));
  }

  function addRule() {
    const pattern = newPattern.trim();
    if (!pattern || !draft) return;
    if (draft.rules.some((r) => r.pattern === pattern && r.action === newAction)) {
      setNewPattern("");
      return;
    }
    setDraft({ ...draft, rules: [...draft.rules, { action: newAction, pattern }] });
    setNewPattern("");
  }

  async function save(clear = false) {
    if (!draft) return;
    setSaving(true);
    try {
      const policy =
        scope === "global"
          ? { mode: draft.mode, presets: draft.presets ?? [], offPolicyCommands: draft.offPolicyCommands, rules: draft.rules }
          : clear
            ? null
            : {
                mode: draft.mode === "inherit" ? undefined : draft.mode,
                presets: draft.presets ?? undefined,
                offPolicyCommands: draft.offPolicyCommands === "inherit" ? undefined : draft.offPolicyCommands,
                rules: draft.rules,
              };
      const response = await fetch("/api/settings/egress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, repoKey, policy }),
      });
      const body = (await response.json().catch(() => null)) as (Snapshot & { error?: string }) | null;
      if (!response.ok || !body) {
        toast.error(body?.error ?? "Could not save the network policy.");
        return;
      }
      adopt(body, scope);
      toast.success(clear ? "This workspace now inherits the global policy." : "Network policy saved.");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    const text = probe.trim();
    if (!text) return;
    const looksLikeCommand = /\s/.test(text) && !/^[a-z]+:\/\//i.test(text);
    const response = await fetch("/api/settings/egress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", repoKey, ...(looksLikeCommand ? { command: text } : { url: text }) }),
    });
    const body = (await response.json().catch(() => null)) as
      | { kind: "url"; allowed: boolean; reason: string; rule: string | null; error?: string }
      | { kind: "command"; action: string; reason: string | null; findings: { target: string; action: string }[]; error?: string }
      | null;
    if (!response.ok || !body) {
      setProbeResult(body?.error ?? "Test failed.");
      return;
    }
    if (body.kind === "url") {
      setProbeResult(`${body.allowed ? "Allowed" : "Blocked"}: ${body.reason}${body.rule ? ` [${body.rule}]` : ""}`);
    } else {
      setProbeResult(
        body.findings.length === 0
          ? "No network access detected in this command."
          : `${body.action.toUpperCase()}: ${body.findings.map((f) => `${f.target} (${f.action})`).join(", ")}${body.reason ? ` — ${body.reason}` : ""}`,
      );
    }
  }

  const effective = snapshot.effective;
  const workspaceScope = scope === "workspace";
  const presetsInherited = workspaceScope && draft.presets === null;
  const shownPresets = draft.presets ?? effective.presets;

  return (
    <>
      <div className="flex flex-col gap-1 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          In force here:
          <span className="font-mono" style={{ color: effective.mode === "open" ? "var(--vb-text-dim)" : "var(--vb-accent)" }}>
            {effective.mode}
          </span>
          <span className="text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
            ({effective.modeFrom === "env" ? "pinned by VIBERON_EGRESS_MODE" : `from ${effective.modeFrom} settings`})
          </span>
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          Sandbox: {snapshot.sandbox.reason}. Shell commands are checked by reading the command text, which is best effort; the sandbox
          and the egress proxy are the boundary for what a process does once it runs.
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          Always allowed for model calls:{" "}
          {snapshot.providerHosts.length ? (
            snapshot.providerHosts.map((p, i) => (
              <span key={p.host}>
                {i > 0 && ", "}
                <span className="font-mono">{p.host}</span> <span style={{ color: "var(--vb-text-faint)" }}>({p.provider})</span>
              </span>
            ))
          ) : (
            <span style={{ color: "var(--vb-text-faint)" }}>no provider configured</span>
          )}
        </p>
        {effective.invalid.length > 0 && (
          <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
            Skipped invalid rules: {effective.invalid.map((r) => `${r.pattern} (${r.error})`).join("; ")}
          </p>
        )}
      </div>

      <Row label="Edit policy for" hint={workspaceScope ? "Overrides for this workspace. Global deny rules still apply." : "The default for every workspace."}>
        <Segmented<Scope>
          size="md"
          value={scope}
          options={[
            { value: "global", label: "All workspaces" },
            ...(repoKey ? [{ value: "workspace" as const, label: "This workspace" }] : []),
          ]}
          onChange={switchScope}
        />
      </Row>

      <Row label="Mode" hint={draft.mode === "inherit" ? `Inherits "${snapshot.global.mode}" from the global policy.` : MODE_HINT[draft.mode]}>
        <Segmented<Inheritable<EgressMode>>
          size="md"
          value={draft.mode}
          options={[
            ...(workspaceScope ? [{ value: "inherit" as const, label: "Inherit" }] : []),
            { value: "open", label: "Open" },
            { value: "allowlist", label: "Allowlist" },
            { value: "deny", label: "Deny" },
          ]}
          onChange={(mode) => update({ mode })}
        />
      </Row>

      <div className="flex flex-col gap-1.5 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            Presets <span className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>(used in allowlist mode)</span>
          </p>
          {workspaceScope && (
            <Checkbox
              checked={presetsInherited}
              onChange={(inherit) => update({ presets: inherit ? null : [...effective.presets] })}
              label="Inherit"
            />
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {snapshot.presets.map((preset) => (
            <Checkbox
              key={preset.id}
              checked={shownPresets.includes(preset.id)}
              disabled={presetsInherited}
              title={`${preset.description}\n${preset.hosts.join(", ")}`}
              onChange={(on) =>
                update({ presets: on ? [...shownPresets, preset.id] : shownPresets.filter((p) => p !== preset.id) })
              }
              label={preset.label}
            />
          ))}
        </div>
      </div>

      <Row label="Off-allowlist commands" hint="A shell command that reaches a host outside the allowlist: ask for approval (even under Auto), or refuse it.">
        <Segmented<Inheritable<OffPolicyCommands>>
          size="md"
          value={draft.offPolicyCommands}
          options={[
            ...(workspaceScope ? [{ value: "inherit" as const, label: "Inherit" }] : []),
            { value: "ask", label: "Ask" },
            { value: "block", label: "Block" },
          ]}
          onChange={(offPolicyCommands) => update({ offPolicyCommands })}
        />
      </Row>

      <div className="flex flex-col gap-1.5 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          Rules
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          <span className="font-mono">example.com</span>, <span className="font-mono">*.example.com</span> (subdomains only),{" "}
          <span className="font-mono">host:8443</span>, <span className="font-mono">10.0.0.0/8</span>,{" "}
          <span className="font-mono">[::1]:3000</span>. Deny beats allow. Private and metadata addresses need a rule that names them.
        </p>
        {draft.rules.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
            No rules in this scope.
          </p>
        ) : (
          <ul className="flex flex-col">
            {draft.rules.map((rule, index) => (
              <li key={`${rule.action}:${rule.pattern}`} className="flex items-center gap-2 py-0.5 text-[12px]">
                <span
                  className="w-10 font-mono text-[11px] uppercase"
                  style={{ color: rule.action === "deny" ? "var(--vb-rose)" : "var(--vb-mint)" }}
                >
                  {rule.action}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono" style={{ color: "var(--vb-text)" }}>
                  {rule.pattern}
                  {rule.note && <span style={{ color: "var(--vb-text-faint)" }}> — {rule.note}</span>}
                </span>
                <button
                  type="button"
                  className="vb-btn vb-btn-ghost"
                  title="Remove rule"
                  onClick={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1.5">
          <Segmented<EgressAction>
            value={newAction}
            options={[
              { value: "allow", label: "Allow" },
              { value: "deny", label: "Deny" },
            ]}
            onChange={setNewAction}
          />
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addRule();
            }}
            placeholder="*.internal.example.com"
            spellCheck={false}
            aria-label="Host pattern"
            className="vb-input min-w-0 flex-1 font-mono"
          />
          <button type="button" className="vb-btn" disabled={!newPattern.trim()} onClick={addRule}>
            Add
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 border-b py-2" style={{ borderColor: "var(--vb-line)" }}>
        {workspaceScope && snapshot.workspace && (
          <button type="button" className="vb-btn vb-btn-ghost" disabled={saving} onClick={() => void save(true)}>
            Clear workspace override
          </button>
        )}
        <button type="button" className="vb-btn vb-btn-ghost" disabled={!dirty || saving} onClick={() => setDraft(draftFrom(snapshot, scope))}>
          Discard
        </button>
        <button type="button" className={cx("vb-btn", dirty && "vb-btn-primary")} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save policy"}
        </button>
      </div>

      <div className="flex flex-col gap-1.5 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          Test a URL or command
        </p>
        <div className="flex items-center gap-1.5">
          <input
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void test();
            }}
            placeholder="https://example.com or git clone git@github.com:org/repo"
            spellCheck={false}
            aria-label="URL or command to test"
            className="vb-input min-w-0 flex-1 font-mono"
          />
          <button type="button" className="vb-btn" disabled={!probe.trim()} onClick={() => void test()}>
            Test
          </button>
        </div>
        {probeResult && (
          <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
            {probeResult}
          </p>
        )}
        <p className="text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
          Tests use the saved policy.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 py-2.5">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            Recent decisions
            <span className="ml-2 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {snapshot.logPath}
            </span>
          </p>
          <Checkbox checked={deniedOnly} onChange={setDeniedOnly} label="Blocked only" />
          <button type="button" className="vb-btn vb-btn-ghost" title="Refresh" onClick={() => void refreshLog()}>
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {log === null ? (
          <p className="text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
            Loading…
          </p>
        ) : log.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
            Nothing logged yet.
          </p>
        ) : (
          <ul className="flex max-h-[260px] flex-col overflow-y-auto font-mono text-[11.5px]">
            {log.map((entry, index) => (
              <li
                key={`${entry.ts}:${index}`}
                className="flex items-baseline gap-2 py-0.5"
                title={[entry.reason, entry.url, entry.command].filter(Boolean).join("\n")}
              >
                <span className="w-12 shrink-0" style={{ color: "var(--vb-text-faint)" }}>
                  {formatAgo(entry.ts)}
                </span>
                <span
                  className="w-10 shrink-0 uppercase"
                  style={{
                    color: entry.decision === "deny" ? "var(--vb-rose)" : entry.decision === "ask" ? "var(--vb-amber)" : "var(--vb-mint)",
                  }}
                >
                  {entry.decision}
                </span>
                <span className="w-16 shrink-0" style={{ color: "var(--vb-text-dim)" }}>
                  {entry.source}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
                  {entry.host}
                  {entry.port ? `:${entry.port}` : ""}
                </span>
                <span className="max-w-[40%] truncate" style={{ color: "var(--vb-text-faint)" }}>
                  {entry.rule}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
