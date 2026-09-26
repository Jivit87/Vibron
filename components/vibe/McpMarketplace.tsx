"use client";

/**
 * The MCP marketplace, as a Settings section: search and filter the catalog,
 * open a server to fill in its settings, review the exact install plan
 * (command, env, warnings), confirm, then test, toggle or remove it.
 *
 * Secret values are only ever sent *to* the server. Everything that comes
 * back carries masked fingerprints (see lib/mcp/marketplace.ts).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useViberon } from "@/store/viberon";
import { Checkbox, cx, Dot, SettingRow as Row, Switch } from "@/components/vibe/primitives";
import { searchCatalog, type CatalogCategory, type CatalogEntry, type CatalogField } from "@/lib/mcp/catalog-search";
import type { InstallPlan, InstalledServer, TestResult } from "@/lib/mcp/marketplace";

interface CatalogResponse {
  entries: CatalogEntry[];
  categories: { id: CatalogCategory; label: string }[];
  installed: InstalledServer[];
  registry: { url: string | null; status: "disabled" | "ok" | "error"; error?: string; added: number; rejected: string[] };
}

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; code?: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!response.ok || !data) return { ok: false, error: data?.error ?? `Request failed (${response.status})`, code: data?.code };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function McpMarketplace({ show }: { show: (text: string) => boolean }) {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogCategory | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async (reload = false) => {
    try {
      const response = await fetch(`/api/mcp/marketplace${reload ? "?refresh=1" : ""}`);
      if (!response.ok) throw new Error(String(response.status));
      setData((await response.json()) as CatalogResponse);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed = useMemo(() => new Map((data?.installed ?? []).map((s) => [s.catalogId, s])), [data]);
  const results = useMemo(() => (data ? searchCatalog(data.entries, query, category) : []), [data, query, category]);
  const usedCategories = useMemo(
    () => (data ? data.categories.filter((c) => data.entries.some((e) => e.category === c.id)) : []),
    [data],
  );

  if (!show("mcp marketplace servers install catalog registry plugins tools")) return null;

  if (!data) {
    return (
      <p className="flex items-center gap-2 py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        {failed ? "Could not load the marketplace." : <><Loader2 className="size-3.5 animate-spin" />Loading catalog</>}
      </p>
    );
  }

  const entry = selected ? data.entries.find((e) => e.id === selected) : undefined;
  if (entry) {
    return (
      <ServerDetail
        key={entry.id}
        entry={entry}
        installed={installed.get(entry.id)}
        onBack={() => setSelected(null)}
        onChanged={() => refresh()}
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${data.entries.length} servers`}
            aria-label="Search MCP servers"
            className="vb-input min-w-0 flex-1"
          />
          <span className="shrink-0 text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
            {installed.size} installed
          </span>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Categories">
          {[{ id: "all" as const, label: "All" }, ...usedCategories].map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              onClick={() => setCategory(c.id)}
              className={cx("vb-btn", category !== c.id && "vb-btn-ghost")}
              style={category === c.id ? { background: "var(--vb-accent-soft)", color: "var(--vb-text-hi)" } : undefined}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {results.length === 0 ? (
        <p className="border-b py-3 text-[12.5px]" style={{ borderColor: "var(--vb-line)", color: "var(--vb-text-dim)" }}>
          No servers match.
        </p>
      ) : (
        <ul className="flex flex-col">
          {results.map((e) => {
            const inst = installed.get(e.id);
            return (
              <li key={e.id} className="border-b" style={{ borderColor: "var(--vb-line)" }}>
                <button
                  type="button"
                  onClick={() => setSelected(e.id)}
                  className="flex w-full flex-col items-start gap-0.5 px-1 py-2 text-left hover:bg-[var(--vb-hover)]"
                >
                  <span className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
                    {e.name}
                    <TrustBadge trust={e.trust} />
                    {inst && <InstalledBadge server={inst} />}
                    <span className="vb-role">{data.categories.find((c) => c.id === e.category)?.label ?? e.category}</span>
                  </span>
                  <span className="line-clamp-2 text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
                    {e.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <RegistryRow registry={data.registry} onChanged={() => refresh(true)} />
    </>
  );
}

function TrustBadge({ trust }: { trust: CatalogEntry["trust"] }) {
  return (
    <span
      className="vb-role"
      title={trust === "official" ? "Published by the service vendor or the MCP project" : "Third-party: review the source before installing"}
      style={{ color: trust === "official" ? "var(--vb-mint)" : "var(--vb-amber)" }}
    >
      {trust}
    </span>
  );
}

function InstalledBadge({ server }: { server: InstalledServer }) {
  return (
    <span className="vb-role flex items-center gap-1">
      <Dot color={server.enabled ? "var(--vb-accent)" : "var(--vb-text-faint)"} />
      {server.enabled ? "installed" : "disabled"}
    </span>
  );
}

/* ------------------------------ detail view ------------------------------- */

function ServerDetail({
  entry,
  installed,
  onBack,
  onChanged,
}: {
  entry: CatalogEntry;
  installed?: InstalledServer;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const repoKey = useViberon((s) => s.repoKey);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(installed?.values ?? {}) }));
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<null | "plan" | "install" | "test" | "remove" | "toggle">(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const setValue = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    // Any edit invalidates the reviewed plan.
    setPlan(null);
    setConfirmed(false);
  };

  async function review() {
    setBusy("plan");
    try {
      const result = await post<{ plan: InstallPlan }>("/api/mcp/marketplace/install", { id: entry.id, values, dryRun: true });
      if (!result.ok) toast.error(result.error);
      else {
        setPlan(result.data.plan);
        setConfirmed(false);
      }
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    if (!plan) return;
    setBusy("install");
    try {
      const result = await post<{ server: InstalledServer }>("/api/mcp/marketplace/install", {
        id: entry.id,
        values,
        confirm: confirmed,
        planHash: plan.planHash,
      });
      if (!result.ok) {
        toast.error(result.error);
        if (result.code === "plan-changed") setPlan(null);
        return;
      }
      toast.success(`${entry.name} ${plan.reinstall ? "updated" : "installed"}. Agents get it as mcp__${entry.id}__*.`);
      setPlan(null);
      setConfirmed(false);
      // Secrets never come back; clear what was typed.
      setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !entry.fields.find((f) => f.name === k)?.secret)));
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy("test");
    setTest(null);
    try {
      const result = await post<TestResult>("/api/mcp/marketplace/test", { name: entry.id, repoKey });
      if (!result.ok) toast.error(result.error);
      else setTest(result.data);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(enabled: boolean) {
    setBusy("toggle");
    try {
      const result = await post("/api/mcp/marketplace/toggle", { name: entry.id, enabled });
      if (!result.ok) toast.error(result.error);
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      const result = await post("/api/mcp/marketplace/uninstall", { name: entry.id });
      if (!result.ok) toast.error(result.error);
      else {
        toast.success(`${entry.name} removed, with its stored secrets.`);
        setTest(null);
        setPlan(null);
        await onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  const secretStatus = (name: string) => installed?.secrets.find((s) => s.name === name);

  return (
    <>
      <div className="flex flex-col gap-1.5 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
        <button type="button" onClick={onBack} className="vb-btn vb-btn-ghost -ml-1 self-start">
          <ArrowLeft className="size-3.5" />
          All servers
        </button>
        <p className="flex flex-wrap items-center gap-2 text-[13px]" style={{ color: "var(--vb-text-hi)" }}>
          {entry.name}
          <TrustBadge trust={entry.trust} />
          {installed && <InstalledBadge server={installed} />}
          {entry.origin === "registry" && <span className="vb-role">from registry</span>}
        </p>
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          {entry.description}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
          {entry.publisher}
          <a href={entry.homepage} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
            Source <ExternalLink className="size-3" />
          </a>
          <span className="font-mono">{entry.transport === "stdio" ? entry.command : entry.url}</span>
        </p>
      </div>

      {installed && (
        <Row label="Enabled" hint="Disabled servers stay configured but are not started for agent runs.">
          <Switch checked={installed.enabled} onChange={(v) => void toggle(v)} label="Enabled" />
        </Row>
      )}

      {entry.fields.map((field) => (
        <FieldRow
          key={field.name}
          field={field}
          value={values[field.name] ?? ""}
          stored={field.secret ? secretStatus(field.name)?.masked ?? null : null}
          onChange={(v) => setValue(field.name, v)}
        />
      ))}

      {plan && <PlanView plan={plan} confirmed={confirmed} onConfirm={setConfirmed} />}

      <div className="flex flex-wrap items-center gap-1 py-2.5">
        {plan ? (
          <button
            type="button"
            className="vb-btn vb-btn-primary"
            disabled={busy !== null || !confirmed || plan.missing.length > 0}
            onClick={() => void install()}
          >
            {busy === "install" ? "Installing…" : plan.reinstall ? "Save changes" : "Install"}
          </button>
        ) : (
          <button type="button" className="vb-btn vb-btn-primary" disabled={busy !== null} onClick={() => void review()}>
            {busy === "plan" ? "Preparing…" : installed ? "Review changes" : "Review install"}
          </button>
        )}
        {installed && (
          <>
            <button type="button" className="vb-btn" disabled={busy !== null} onClick={() => void runTest()}>
              {busy === "test" ? "Starting server…" : "Test connection"}
            </button>
            <div className="flex-1" />
            <button type="button" className="vb-btn vb-btn-ghost vb-btn-danger" disabled={busy !== null} onClick={() => void remove()}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          </>
        )}
      </div>

      {test && <TestView result={test} />}
    </>
  );
}

function FieldRow({
  field,
  value,
  stored,
  onChange,
}: {
  field: CatalogField;
  value: string;
  stored: string | null;
  onChange: (value: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const placeholder = field.secret && stored ? `Stored ${stored}. Leave empty to keep it.` : (field.placeholder ?? field.default ?? "");
  return (
    <div className="flex flex-col gap-1.5 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <p className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
        {field.label}
        <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {field.name}
        </span>
        {field.required ? null : <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>optional</span>}
        {field.secret && <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>secret</span>}
      </p>
      {field.description && (
        <p className="text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          {field.description}
        </p>
      )}
      <div className="relative">
        <input
          type={field.secret && !reveal ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={field.label}
          className={cx("vb-input w-full font-mono", field.secret && "pr-8")}
        />
        {field.secret && (
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            title={reveal ? "Hide" : "Show"}
            className="absolute right-1.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--vb-text-dim)" }}
          >
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

function PlanView({ plan, confirmed, onConfirm }: { plan: InstallPlan; confirmed: boolean; onConfirm: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <p className="vb-label">{plan.reinstall ? "What will change" : "What will run"}</p>
      <pre
        className="vb-box overflow-x-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-[11.5px]"
        style={{ color: "var(--vb-text-hi)" }}
      >
        {plan.commandLine ?? `${plan.transport.toUpperCase()} ${plan.url}`}
        {Object.entries(plan.headers ?? {}).map(([k, v]) => `\n${k}: ${v}`)}
      </pre>
      {plan.env.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            Environment
          </p>
          {plan.env.map((e) => (
            <p key={e.name} className="font-mono text-[11.5px]" style={{ color: "var(--vb-text)" }}>
              {e.name}=<span style={{ color: e.secret ? "var(--vb-text-dim)" : undefined }}>{e.value}</span>
            </p>
          ))}
        </div>
      )}
      {plan.inheritedEnv.length > 0 && (
        <p className="text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
          Also inherits only <span className="font-mono">{plan.inheritedEnv.join(", ")}</span>. Your provider API keys are not passed.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {plan.warnings.map((w) => (
          <li key={w} className="text-[12px] leading-snug" style={{ color: "var(--vb-amber)" }}>
            {w}
          </li>
        ))}
      </ul>
      {plan.missing.length > 0 ? (
        <p className="text-[12px]" style={{ color: "var(--vb-rose)" }}>
          Fill in {plan.missing.join(", ")} first.
        </p>
      ) : (
        <Checkbox
          checked={confirmed}
          onChange={onConfirm}
          label="I reviewed this command and allow Viberon to run it for agent sessions."
        />
      )}
    </div>
  );
}

function TestView({ result }: { result: TestResult }) {
  const [showLogs, setShowLogs] = useState(!result.ok);
  return (
    <div className="flex flex-col gap-1.5 border-t py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <p className="flex items-center gap-2 text-[12.5px]" style={{ color: result.ok ? "var(--vb-text)" : "var(--vb-rose)" }}>
        <Dot color={result.ok ? "var(--vb-mint)" : "var(--vb-rose)"} />
        {result.ok
          ? `Connected${result.serverInfo ? ` to ${result.serverInfo.name} ${result.serverInfo.version}` : ""} — ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} in ${(result.durationMs / 1000).toFixed(1)}s`
          : (result.error ?? "Failed")}
      </p>
      {result.tools.length > 0 && (
        <ul className="flex flex-col">
          {result.tools.map((t) => (
            <li key={t.name} className="flex gap-2 text-[12px]">
              <span className="shrink-0 font-mono" style={{ color: "var(--vb-text)" }}>
                {t.name}
              </span>
              <span className="truncate" style={{ color: "var(--vb-text-dim)" }}>
                {t.description.split("\n")[0]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.logs.length > 0 && (
        <>
          <button type="button" className="vb-btn vb-btn-ghost -ml-1 self-start" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? "Hide log" : "Show log"}
          </button>
          {showLogs && (
            <pre className="vb-box max-h-48 overflow-auto px-2 py-1.5 font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              {result.logs.join("\n")}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function RegistryRow({ registry, onChanged }: { registry: CatalogResponse["registry"]; onChanged: () => Promise<void> }) {
  const [url, setUrl] = useState(registry.url ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/mcp/marketplace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryUrl: url.trim() }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; registry?: CatalogResponse["registry"] } | null;
      if (!response.ok) toast.error(body?.error ?? "Could not save the registry.");
      else if (body?.registry?.status === "error") toast.error(`Saved, but the registry is unavailable: ${body.registry.error}`);
      else toast.success(url.trim() ? `Registry added ${body?.registry?.added ?? 0} servers.` : "Registry removed.");
      await onChanged();
    } finally {
      setSaving(false);
    }
  }

  const status =
    registry.status === "ok"
      ? `${registry.added} extra server${registry.added === 1 ? "" : "s"}${registry.rejected.length ? `, ${registry.rejected.length} rejected` : ""}`
      : registry.status === "error"
        ? `unavailable (${registry.error}); showing the bundled catalog`
        : "Optional. An https URL serving a catalog index merged below the bundled list.";

  return (
    <Row label="Remote registry" hint={status}>
      <div className="flex items-center gap-1">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/mcp-registry.json"
          spellCheck={false}
          aria-label="Registry URL"
          className="vb-input w-60 font-mono"
        />
        <button type="button" className="vb-btn" disabled={saving || url.trim() === (registry.url ?? "")} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Row>
  );
}
