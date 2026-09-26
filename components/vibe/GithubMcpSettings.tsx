"use client";

/**
 * Settings rows for the GitHub MCP server: connection mode, token, toolsets,
 * read-only and trust. Everything round-trips through /api/mcp/github; the
 * token itself never comes back, only its masked fingerprint.
 */

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useViberon } from "@/store/viberon";
import { Checkbox, Segmented, SettingRow as Row, Switch } from "@/components/vibe/primitives";
import { DEFAULT_GITHUB_TOOLSETS, GITHUB_TOOLSETS, type GithubMode } from "@/lib/mcp/github-toolsets";

interface GithubStatus {
  configured: boolean;
  mode?: GithubMode;
  maskedToken?: string;
  toolsets?: string[];
  readOnly?: boolean;
  trusted?: boolean;
  enabled?: boolean;
  host?: string;
  shadowedBy?: string | null;
  status?: string;
  error?: string;
  toolCount?: number;
  serverInfo?: { name: string; version: string };
}

const MODE_HINT: Record<GithubMode, string> = {
  remote: "GitHub's hosted server at api.githubcopilot.com. Nothing to install.",
  docker: "Runs ghcr.io/github/github-mcp-server locally. Docker must be running.",
  binary: "Runs a github-mcp-server binary from your PATH.",
};

const SHADOW_LABEL: Record<string, string> = {
  viberon: ".viberon/mcp.json",
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
};

export function GithubMcpSettings({ show }: { show: (text: string) => boolean }) {
  const repoKey = useViberon((s) => s.repoKey);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [mode, setMode] = useState<GithubMode>("remote");
  const [toolsets, setToolsets] = useState<string[]>(DEFAULT_GITHUB_TOOLSETS);
  const [readOnly, setReadOnly] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "gh" | "test" | "remove">(null);

  const adopt = useCallback((next: GithubStatus) => {
    setStatus(next);
    if (!next.configured) return;
    setMode(next.mode ?? "remote");
    setToolsets(next.toolsets?.length ? next.toolsets : DEFAULT_GITHUB_TOOLSETS);
    setReadOnly(Boolean(next.readOnly));
    setTrusted(Boolean(next.trusted));
    setHost(next.host ?? "");
  }, []);

  const refresh = useCallback(
    async (connect = false) => {
      try {
        const response = await fetch(`/api/mcp/github?repoKey=${encodeURIComponent(repoKey)}${connect ? "&connect=1" : ""}`);
        if (response.ok) adopt((await response.json()) as GithubStatus);
      } catch {
        setStatus({ configured: false });
      }
    },
    [repoKey, adopt],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(useGhCli = false) {
    setBusy(useGhCli ? "gh" : "save");
    try {
      const response = await fetch("/api/mcp/github", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, token: token.trim(), useGhCli, toolsets, readOnly, trusted, host, repoKey }),
      });
      const body = (await response.json().catch(() => null)) as (GithubStatus & { error?: string; login?: string }) | null;
      if (!response.ok || !body) {
        toast.error(body?.error ?? "Could not save the GitHub server.");
        return;
      }
      adopt(body);
      setToken("");
      if (body.status === "connected") {
        toast.success(`GitHub connected${body.login ? ` as ${body.login}` : ""} — ${body.toolCount} tools.`);
      } else {
        toast.error(`Saved, but the server did not connect: ${body.error ?? body.status}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      await refresh(true);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await fetch(`/api/mcp/github?repoKey=${encodeURIComponent(repoKey)}`, { method: "DELETE" });
      toast.success("GitHub server removed.");
      setStatus({ configured: false });
      setToolsets(DEFAULT_GITHUB_TOOLSETS);
    } finally {
      setBusy(null);
    }
  }

  function toggleToolset(id: string) {
    setToolsets((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  if (!show("github mcp server token toolsets integration pull requests issues")) return null;

  if (!status) {
    return (
      <p className="flex items-center gap-2 py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        <Loader2 className="size-3.5 animate-spin" />
        Checking GitHub server
      </p>
    );
  }

  const configured = status.configured;
  const visibleToolsets = GITHUB_TOOLSETS.filter((t) => !t.remoteOnly || mode === "remote");

  return (
    <>
      <div className="flex flex-col gap-1 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          GitHub
          <StatusDot status={status} />
          {configured && (
            <span className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {status.maskedToken}
            </span>
          )}
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          Agents get GitHub tools as <span className="font-mono">mcp__github__*</span> — repos, issues, pull requests, Actions and more,
          via GitHub&apos;s official MCP server.{" "}
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Create a token
          </a>
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-faint)" }}>
          The token is also used for private clones and issue lookups.
        </p>
        {status.shadowedBy && (
          <p className="text-[12px]" style={{ color: "var(--vb-amber)" }}>
            This workspace&apos;s {SHADOW_LABEL[status.shadowedBy] ?? status.shadowedBy} defines its own &quot;github&quot; server, which is used
            instead of this one.
          </p>
        )}
        {status.error && status.status === "error" && (
          <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
            {status.error}
          </p>
        )}
      </div>

      <Row label="Connection" hint={MODE_HINT[mode]}>
        <Segmented<GithubMode>
          size="md"
          value={mode}
          options={[
            { value: "remote", label: "Hosted" },
            { value: "docker", label: "Docker" },
            { value: "binary", label: "Binary" },
          ]}
          onChange={setMode}
        />
      </Row>

      {mode !== "remote" && (
        <Row label="GitHub host" hint="Only for GitHub Enterprise Server or ghe.com. Leave empty for github.com.">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="https://github.example.com"
            spellCheck={false}
            className="vb-input w-64 font-mono"
          />
        </Row>
      )}

      <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          Token
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative min-w-[200px] flex-1">
            <input
              type={reveal ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder={configured ? "Leave empty to keep the current token" : "github_pat_… or ghp_…"}
              spellCheck={false}
              autoComplete="off"
              aria-label="GitHub token"
              className="vb-input w-full pr-8 font-mono"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              title={reveal ? "Hide" : "Show"}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--vb-text-dim)" }}
            >
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <button
            type="button"
            className="vb-btn"
            disabled={busy !== null}
            onClick={() => void save(true)}
            title="Use the token from `gh auth token`"
          >
            {busy === "gh" ? "Verifying…" : "Use gh CLI login"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <div className="flex items-center gap-2">
          <p className="flex-1 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            Toolsets
          </p>
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => setToolsets(DEFAULT_GITHUB_TOOLSETS)}>
            Defaults
          </button>
        </div>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          Every enabled tool is sent with every agent prompt. Enable only what you use.
        </p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2">
          {visibleToolsets.map((t) => (
            <Checkbox
              key={t.id}
              checked={toolsets.includes(t.id)}
              onChange={() => toggleToolset(t.id)}
              title={t.id}
              label={<span className="truncate">{t.label}</span>}
            />
          ))}
        </div>
      </div>

      <Row label="Read-only" hint="Expose only tools that read from GitHub. Agents cannot open PRs, comment or push.">
        <Switch checked={readOnly} onChange={setReadOnly} label="Read-only" />
      </Row>
      <Row label="Trust this server" hint="Skip the approval prompt for GitHub tool calls when shell commands are set to Ask.">
        <Switch checked={trusted} onChange={setTrusted} label="Trust this server" />
      </Row>

      <div className="flex items-center gap-1 py-2.5">
        <button
          type="button"
          className="vb-btn vb-btn-primary"
          disabled={busy !== null || (!configured && !token.trim())}
          onClick={() => void save()}
        >
          {busy === "save" ? "Connecting…" : configured ? "Save" : "Connect"}
        </button>
        {configured && (
          <>
            <button type="button" className="vb-btn" disabled={busy !== null} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <div className="flex-1" />
            <button type="button" className="vb-btn vb-btn-ghost vb-btn-danger" disabled={busy !== null} onClick={() => void remove()}>
              Remove
            </button>
          </>
        )}
      </div>
    </>
  );
}

function StatusDot({ status }: { status: GithubStatus }) {
  if (!status.configured) {
    return (
      <span className="text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
        not connected
      </span>
    );
  }
  const s = status.status ?? "idle";
  const color = s === "connected" ? "var(--vb-mint)" : s === "error" ? "var(--vb-rose)" : "var(--vb-text-faint)";
  const label =
    s === "connected"
      ? `connected · ${status.toolCount ?? 0} tools`
      : s === "idle"
        ? "connects on next run"
        : s;
  return (
    <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
