"use client";

/**
 * Settings rows for GitLab and Bitbucket: the credentials delivery, issue
 * intake, CI watch and private clones use for those hosts (GitHub's token is
 * the GitHub MCP row above). Round-trips through /api/settings/git; secrets
 * never come back, only masked fingerprints. See docs/MULTI_GIT.md.
 */

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

import { Segmented, SettingRow as Row } from "@/components/vibe/primitives";

interface GitHostStatus {
  gitlab: { configured: boolean; masked: string | null; baseUrl: string; fromEnv: boolean };
  bitbucket: { configured: boolean; masked: string | null; mode: "basic" | "bearer" | null; username: string | null; fromEnv: boolean };
}

type BitbucketMode = "basic" | "bearer";

async function send(method: "PUT" | "DELETE", body?: Record<string, unknown>, query = ""): Promise<(GitHostStatus & { login?: string }) | null> {
  const response = await fetch(`/api/settings/git${query}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => null)) as (GitHostStatus & { error?: string; login?: string }) | null;
  if (!response.ok || !data) {
    toast.error(data?.error ?? "Could not save those credentials.");
    return null;
  }
  return data;
}

export function GitHostSettings({ show }: { show: (text: string) => boolean }) {
  const [status, setStatus] = useState<GitHostStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/git");
      if (response.ok) setStatus((await response.json()) as GitHostStatus);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {show("gitlab token merge request self-hosted integration") && <GitLabRows status={status?.gitlab ?? null} onStatus={setStatus} />}
      {show("bitbucket app password access token pull request integration") && (
        <BitbucketRows status={status?.bitbucket ?? null} onStatus={setStatus} />
      )}
    </>
  );
}

function Header({ title, configured, masked, fromEnv, envVar, blurb, link }: {
  title: string;
  configured: boolean;
  masked: string | null;
  fromEnv: boolean;
  envVar: string;
  blurb: string;
  link: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-1 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <p className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
        {title}
        <span className="font-mono text-[11.5px]" style={{ color: configured ? "var(--vb-text-dim)" : "var(--vb-text-faint)" }}>
          {configured ? masked : "not set"}
        </span>
        {fromEnv && (
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={`From ${envVar}`}>
            ${envVar}
          </span>
        )}
      </p>
      <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
        {blurb}{" "}
        <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {link.label}
        </a>
      </p>
    </div>
  );
}

function SecretInput({ value, onChange, onEnter, placeholder, label }: {
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  placeholder: string;
  label: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative w-64">
      <input
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
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
  );
}

function Actions({ busy, canSave, configured, removable, onSave, onRemove }: {
  busy: null | "save" | "remove";
  canSave: boolean;
  configured: boolean;
  removable: boolean;
  onSave: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <button type="button" className="vb-btn vb-btn-primary" disabled={busy !== null || !canSave} onClick={onSave}>
        {busy === "save" ? "Verifying…" : configured ? "Save" : "Connect"}
      </button>
      {removable && (
        <>
          <div className="flex-1" />
          <button type="button" className="vb-btn vb-btn-ghost vb-btn-danger" disabled={busy !== null} onClick={onRemove}>
            Remove
          </button>
        </>
      )}
    </div>
  );
}

function GitLabRows({ status, onStatus }: { status: GitHostStatus["gitlab"] | null; onStatus: (s: GitHostStatus) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "save" | "remove">(null);

  useEffect(() => {
    if (status) setBaseUrl(status.baseUrl === "https://gitlab.com" ? "" : status.baseUrl);
  }, [status]);

  const configured = Boolean(status?.configured);
  const stored = configured && !status?.fromEnv;

  async function save() {
    setBusy("save");
    try {
      const data = await send("PUT", { platform: "gitlab", token: token.trim(), baseUrl: baseUrl.trim() });
      if (!data) return;
      onStatus(data);
      setToken("");
      toast.success(`GitLab connected${data.login ? ` as ${data.login}` : ""}.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      const data = await send("DELETE", undefined, "?platform=gitlab");
      if (data) {
        onStatus(data);
        toast.success("GitLab credentials removed.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Header
        title="GitLab"
        configured={configured}
        masked={status?.masked ?? null}
        fromEnv={Boolean(status?.fromEnv)}
        envVar="GITLAB_TOKEN"
        blurb="Merge requests, issues, pipelines and private clones on gitlab.com or your own instance. Needs the api scope."
        link={{ href: "https://gitlab.com/-/user_settings/personal_access_tokens", label: "Create a token" }}
      />
      <Row label="GitLab URL" hint="Only for a self-hosted instance. Leave empty for gitlab.com. The token is sent to this host only.">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://gitlab.example.com"
          spellCheck={false}
          className="vb-input w-64 font-mono"
        />
      </Row>
      <Row label="Access token" hint={stored ? "Leave empty to keep the current token." : "Personal, group or project access token."}>
        <SecretInput value={token} onChange={setToken} onEnter={() => void save()} placeholder="glpat-…" label="GitLab token" />
      </Row>
      <Actions
        busy={busy}
        canSave={Boolean(token.trim()) || stored}
        configured={configured}
        removable={stored}
        onSave={() => void save()}
        onRemove={() => void remove()}
      />
    </>
  );
}

function BitbucketRows({ status, onStatus }: { status: GitHostStatus["bitbucket"] | null; onStatus: (s: GitHostStatus) => void }) {
  const [mode, setMode] = useState<BitbucketMode>("basic");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<null | "save" | "remove">(null);

  useEffect(() => {
    if (status?.mode) setMode(status.mode);
    if (status?.username) setUsername(status.username);
  }, [status]);

  const configured = Boolean(status?.configured);
  const stored = configured && !status?.fromEnv;
  const keepsSecret = stored && status?.mode === mode && (mode === "bearer" || status?.username === username.trim());

  async function save() {
    setBusy("save");
    try {
      const body =
        mode === "basic"
          ? { platform: "bitbucket", mode, username: username.trim(), appPassword: secret.trim() }
          : { platform: "bitbucket", mode, token: secret.trim() };
      const data = await send("PUT", body);
      if (!data) return;
      onStatus(data);
      setSecret("");
      toast.success(`Bitbucket connected${data.login ? ` as ${data.login}` : ""}.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      const data = await send("DELETE", undefined, "?platform=bitbucket");
      if (data) {
        onStatus(data);
        toast.success("Bitbucket credentials removed.");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Header
        title="Bitbucket"
        configured={configured}
        masked={status?.masked ?? null}
        fromEnv={Boolean(status?.fromEnv)}
        envVar={status?.mode === "basic" ? "BITBUCKET_APP_PASSWORD" : "BITBUCKET_TOKEN"}
        blurb="Pull requests, issues, build statuses and private clones on bitbucket.org."
        link={{ href: "https://support.atlassian.com/bitbucket-cloud/docs/access-tokens/", label: "About tokens" }}
      />
      <Row
        label="Authentication"
        hint={
          mode === "basic"
            ? "Your Bitbucket username and an app password with repository, pull request and issue scopes."
            : "A repository, project or workspace access token."
        }
      >
        <Segmented<BitbucketMode>
          size="md"
          value={mode}
          options={[
            { value: "basic", label: "App password" },
            { value: "bearer", label: "Access token" },
          ]}
          onChange={setMode}
        />
      </Row>
      {mode === "basic" && (
        <Row label="Username" hint="Your Bitbucket username (not your email).">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            spellCheck={false}
            autoComplete="off"
            className="vb-input w-64 font-mono"
          />
        </Row>
      )}
      <Row label={mode === "basic" ? "App password" : "Access token"} hint={keepsSecret ? "Leave empty to keep the current one." : undefined}>
        <SecretInput
          value={secret}
          onChange={setSecret}
          onEnter={() => void save()}
          placeholder={mode === "basic" ? "ATBB…" : "ATCTT…"}
          label={mode === "basic" ? "Bitbucket app password" : "Bitbucket access token"}
        />
      </Row>
      <Actions
        busy={busy}
        canSave={(mode === "bearer" || Boolean(username.trim())) && (Boolean(secret.trim()) || keepsSecret)}
        configured={configured}
        removable={stored}
        onSave={() => void save()}
        onRemove={() => void remove()}
      />
    </>
  );
}
