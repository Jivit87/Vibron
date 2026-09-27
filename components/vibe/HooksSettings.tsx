"use client";

/**
 * Settings → Hooks: the hooks configured for this workspace and for the
 * user, the one-time trust approval that workspace hooks need before they
 * run, and the most recent hook runs. Everything round-trips through
 * /api/hooks; approval sends back the exact file hash that was shown.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useViberon } from "@/store/viberon";
import { formatAgo } from "@/components/vibe/primitives";

interface HookRow {
  id: string;
  event: string;
  matcher: string | null;
  command: string;
  timeoutSec: number;
}

interface HookFile {
  path: string;
  exists: boolean;
  errors: string[];
  hooks: HookRow[];
}

interface RecentRun {
  id: string;
  at: number;
  event: string;
  source: string;
  label: string;
  tool?: string;
  outcome: "proceed" | "blocked" | "modified" | "error" | "skipped";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  message: string;
}

interface HooksStatus {
  global: HookFile | null;
  workspace: (HookFile & { hash: string | null; trust: "trusted" | "untrusted" | "changed" | "none"; approvedAt: string | null }) | null;
  builtins: { name: string; event: string; matcher?: string }[];
  activeCount: number;
  rootPath: string | null;
  recent: RecentRun[];
}

const TRUST_TEXT = {
  trusted: { label: "trusted", color: "var(--vb-mint)" },
  untrusted: { label: "not trusted: these hooks do not run", color: "var(--vb-amber)" },
  changed: { label: "changed since approval: these hooks do not run", color: "var(--vb-amber)" },
  none: { label: "no hooks file", color: "var(--vb-text-faint)" },
} as const;

const OUTCOME_COLOR: Record<RecentRun["outcome"], string> = {
  proceed: "var(--vb-text-dim)",
  modified: "var(--vb-text-mid)",
  blocked: "var(--vb-amber)",
  error: "var(--vb-rose)",
  skipped: "var(--vb-text-faint)",
};

export function HooksSettings({ show }: { show: (text: string) => boolean }) {
  const repoKey = useViberon((s) => s.repoKey);
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "trust" | "revoke">(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/hooks?repoKey=${encodeURIComponent(repoKey)}`);
      if (response.ok) setStatus((await response.json()) as HooksStatus);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [repoKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(action: "trust" | "revoke") {
    setBusy(action);
    try {
      const response = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repoKey, hash: status?.workspace?.hash }),
      });
      const body = (await response.json().catch(() => null)) as (HooksStatus & { error?: string }) | null;
      if (!response.ok || !body || body.error) {
        toast.error(body?.error ?? "Could not update hook trust.");
        await refresh();
        return;
      }
      setStatus(body);
      toast.success(action === "trust" ? "Workspace hooks approved. They run from the next agent run." : "Approval revoked.");
    } finally {
      setBusy(null);
    }
  }

  if (!show("hooks pretooluse posttooluse stop sessionstart userpromptsubmit trust lifecycle")) return null;

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        <Loader2 className="size-3.5 animate-spin" />
        Reading hooks
      </p>
    );
  }
  if (!status) {
    return (
      <p className="py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        Could not read hook configuration.
      </p>
    );
  }

  const ws = status.workspace;
  const trust = TRUST_TEXT[ws?.trust ?? "none"];

  return (
    <>
      <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            Workspace hooks <span className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>.viberon/hooks.json</span>
          </p>
          <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
            <span className="size-1.5 rounded-full" style={{ background: trust.color }} />
            {trust.label}
          </span>
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => void refresh()} title="Reload">
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {!status.rootPath ? (
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            Open a local folder to use workspace hooks.
          </p>
        ) : ws?.exists ? (
          <>
            <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
              Hooks from a repository are commands written by whoever wrote it. They run only after you approve this exact
              version of the file; any change to it needs a new approval.
            </p>
            <HookList hooks={ws.hooks} errors={ws.errors} />
            <div className="flex flex-wrap items-center gap-1.5">
              {ws.trust !== "trusted" && ws.hooks.length > 0 && (
                <button type="button" className="vb-btn vb-btn-primary" disabled={busy !== null} onClick={() => void act("trust")}>
                  {busy === "trust" ? "Approving…" : `Approve ${ws.hooks.length} hook${ws.hooks.length === 1 ? "" : "s"}`}
                </button>
              )}
              {ws.trust !== "untrusted" && (
                <button type="button" className="vb-btn vb-btn-ghost vb-btn-danger" disabled={busy !== null} onClick={() => void act("revoke")}>
                  {busy === "revoke" ? "Revoking…" : "Revoke approval"}
                </button>
              )}
              {ws.hash && (
                <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={ws.hash}>
                  sha256 {ws.hash.slice(0, 12)}
                  {ws.approvedAt && ws.trust === "trusted" ? ` · approved ${formatAgo(ws.approvedAt)}` : ""}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            None. Add <span className="font-mono">.viberon/hooks.json</span> to run commands before or after tool calls.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          Your hooks{" "}
          <span className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
            {status.global?.path ?? "~/.viberon/hooks.json"}
          </span>
        </p>
        {status.global?.exists ? (
          <HookList hooks={status.global.hooks} errors={status.global.errors} />
        ) : (
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            None. Hooks in this file apply to every workspace and need no approval.
          </p>
        )}
        {status.builtins.length > 0 && (
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            Built in: {status.builtins.map((b) => `${b.name} (${b.event})`).join(", ")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 py-2.5">
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          Recent hook runs
        </p>
        {status.recent.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            No hooks have run in this workspace since the app started.
          </p>
        ) : (
          <div className="flex flex-col">
            {status.recent.slice(0, 25).map((run) => (
              <div
                key={run.id}
                className="flex h-[22px] items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[11.5px]"
                title={run.message || undefined}
              >
                <span className="w-[64px] shrink-0" style={{ color: "var(--vb-text-faint)" }}>
                  {formatAgo(run.at)}
                </span>
                <span className="w-[120px] shrink-0 truncate" style={{ color: "var(--vb-text-mid)" }}>
                  {run.event}
                  {run.tool ? ` ${run.tool}` : ""}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text-dim)" }}>
                  {run.label}
                </span>
                <span className="shrink-0" style={{ color: OUTCOME_COLOR[run.outcome] }}>
                  {run.timedOut ? "timed out" : run.outcome}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function HookList({ hooks, errors }: { hooks: HookRow[]; errors: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      {hooks.map((h) => (
        <div key={h.id} className="flex items-baseline gap-2 font-mono text-[11.5px]" title={`timeout ${h.timeoutSec}s`}>
          <span className="shrink-0" style={{ color: "var(--vb-text-mid)" }}>
            {h.event}
            {h.matcher ? `(${h.matcher})` : ""}
          </span>
          <span className="min-w-0 break-all" style={{ color: "var(--vb-text-dim)" }}>
            {h.command}
          </span>
        </div>
      ))}
      {errors.map((e) => (
        <p key={e} className="text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
          {e}
        </p>
      ))}
    </div>
  );
}
