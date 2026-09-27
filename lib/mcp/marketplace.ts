/**
 * MCP marketplace: turn a catalog entry into an installed user-global MCP
 * server, and manage it afterwards.
 *
 * An install is an ordinary entry in the global server list (the same one
 * the MCP settings and the GitHub integration write), tagged with
 * `catalogId`. Pooling, approvals, role filtering and tool naming therefore
 * all come from the generic MCP layer unchanged.
 *
 * Secrets never enter the config. A secret field is written to the
 * credentials store (`setMcpSecret`) and the config holds `${secret:NAME}`,
 * which the manager resolves at launch. Nothing returned from this module
 * carries a secret value: plans and summaries show masked fingerprints.
 *
 * Installing is two-step. `planInstall` shows exactly what will run (command,
 * args, env, headers, warnings) and a `planHash` of the config it would
 * write; `installServer` refuses unless it is confirmed with the same hash,
 * so what gets written is what the user reviewed.
 */

import { createHash } from "node:crypto";

import { getMcpSecrets, mcpSecretStatus, setMcpSecret, type McpSecretStatus } from "@/lib/ai/credentials";
import { placeholders, type CatalogEntry } from "@/lib/mcp/catalog";
import {
  parseServerEntry,
  redactRecord,
  secretRef,
  secretRefs,
  type McpServerConfig,
  type RawServerEntry,
} from "@/lib/mcp/config";
import { disconnectEverywhere, disconnectServer, ensureConnected, serverLogs } from "@/lib/mcp/manager";
import { getGlobalEntries, setGlobalEntry } from "@/lib/mcp/settings";

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: "plan-changed" | "not-confirmed" | "conflict" | "not-found" | "invalid",
  ) {
    super(message);
  }
}

/* ------------------------------- registry url ------------------------------ */

const REGISTRY_URL_KEY = "mcp:marketplace:registry-url";

type StoreModule = typeof import("@/lib/store");
let storePromise: Promise<StoreModule> | null = null;
function store(): Promise<StoreModule> {
  if (!storePromise) storePromise = import("@/lib/store");
  return storePromise;
}

/** The configured registry: settings first, then `VIBERON_MCP_REGISTRY_URL`, else none. */
export async function getRegistryUrl(): Promise<string | null> {
  const { getValueRaw } = await store();
  const saved = await getValueRaw<string>(REGISTRY_URL_KEY);
  const url = (saved ?? process.env.VIBERON_MCP_REGISTRY_URL ?? "").trim();
  return url || null;
}

export async function setRegistryUrl(url: string | null): Promise<void> {
  const value = url?.trim() ?? "";
  if (value) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new MarketplaceError("Registry URL is not a valid URL.", 400, "invalid");
    }
    if (parsed.protocol !== "https:") throw new MarketplaceError("Registry URL must use https.", 400, "invalid");
  }
  const { setValueRaw } = await store();
  await setValueRaw(REGISTRY_URL_KEY, value || null);
}

/* --------------------------------- plans ---------------------------------- */

export interface PlanEnvVar {
  name: string;
  /** The literal value, or a masked fingerprint / "(not set)" for secrets. */
  value: string;
  secret: boolean;
}

export interface InstallPlan {
  id: string;
  serverName: string;
  displayName: string;
  trust: CatalogEntry["trust"];
  origin: CatalogEntry["origin"];
  publisher: string;
  homepage: string;
  transport: CatalogEntry["transport"];
  /** stdio: what is spawned. Secrets appear as `${secret:NAME}`. */
  command?: string;
  args?: string[];
  commandLine?: string;
  /** http/sse: where it connects and with which (redacted) headers. */
  url?: string;
  headers?: Record<string, string>;
  env: PlanEnvVar[];
  /** Variables every stdio server inherits besides `env`. */
  inheritedEnv: string[];
  secrets: McpSecretStatus[];
  warnings: string[];
  /** Required fields with no value (install is refused until filled). */
  missing: string[];
  /** Replacing an existing marketplace install of the same server. */
  reinstall: boolean;
  planHash: string;
}

/** What `getDefaultEnvironment()` in the MCP SDK passes through on each OS. */
export const INHERITED_ENV =
  process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_VALUE = 4096;

function cleanValue(field: string, value: unknown, secret: boolean): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new MarketplaceError(`${field} must be a string.`, 400, "invalid");
  const v = value.trim();
  if (v.length > MAX_VALUE) throw new MarketplaceError(`${field} is too long.`, 400, "invalid");
  if (CONTROL.test(v)) throw new MarketplaceError(`${field} contains control characters.`, 400, "invalid");
  // A non-secret value is written into the config verbatim, where `${…}`
  // would be expanded against the environment at launch.
  if (!secret && v.includes("${")) throw new MarketplaceError(`${field} cannot contain "\${".`, 400, "invalid");
  return v;
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function hashEntry(id: string, entry: RawServerEntry): string {
  return createHash("sha256").update(JSON.stringify({ id, entry })).digest("hex").slice(0, 16);
}

export interface BuildResult {
  entry: RawServerEntry;
  missing: string[];
  /** Non-secret values, remembered so the form can be prefilled later. */
  values: Record<string, string>;
  /** Secret values supplied with this request (to be stored on install). */
  newSecrets: Record<string, string>;
}

/**
 * Pure: the config entry an install would write. `stored` names secrets
 * already in the credentials store (kept when the form leaves them blank).
 */
export function buildInstallEntry(
  catalog: CatalogEntry,
  input: Record<string, unknown>,
  stored: Set<string> = new Set(),
  previous?: RawServerEntry,
): BuildResult {
  const resolved: Record<string, string> = {};
  const values: Record<string, string> = {};
  const newSecrets: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of catalog.fields) {
    const given = cleanValue(field.label, input[field.name], field.secret);
    if (field.secret) {
      if (given) newSecrets[field.name] = given;
      if (given || stored.has(field.name)) resolved[field.name] = secretRef(field.name);
    } else {
      const value = given || field.default || "";
      if (value) {
        resolved[field.name] = value;
        values[field.name] = value;
      }
    }
    if (field.required && !resolved[field.name]) missing.push(field.name);
  }

  // A template naming an unset optional field is dropped whole, so an
  // optional `--flag={{X}}` or header disappears rather than going out empty.
  const fill = (template: string): string | null => {
    const refs = placeholders(template);
    if (refs.some((r) => !resolved[r])) return null;
    return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, name: string) => resolved[name]!);
  };

  const base: RawServerEntry = {
    catalogId: catalog.id,
    ...(previous?.trusted ? { trusted: true } : {}),
  };
  let entry: RawServerEntry;
  if (catalog.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const field of catalog.fields) {
      if (field.inject === "env" && resolved[field.name]) env[field.name] = resolved[field.name]!;
    }
    entry = {
      ...base,
      command: catalog.command!,
      args: catalog.args.map(fill).filter((a): a is string => a !== null),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } else {
    const headers: Record<string, string> = {};
    for (const [name, template] of Object.entries(catalog.headers)) {
      const value = fill(template);
      if (value !== null) headers[name] = value;
    }
    entry = {
      ...base,
      type: catalog.transport,
      url: catalog.url!,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  if (Object.keys(values).length > 0) entry.catalogValues = values;
  return { entry, missing, values, newSecrets };
}

/** The package an `npx` / `uvx` / `docker run` line will fetch. */
export function packageSpec(command: string, args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  if (command === "docker") return positional.find((a) => a !== "run") ?? null;
  return positional[0] ?? null;
}

function warningsFor(catalog: CatalogEntry, entry: RawServerEntry, registryUrl: string | null): string[] {
  const warnings: string[] = [];
  if (catalog.transport === "stdio") {
    const spec = packageSpec(catalog.command!, entry.args ?? []);
    const runner =
      catalog.command === "npx"
        ? `the npm package ${spec ?? "(unknown)"} via npx`
        : catalog.command === "uvx"
          ? `the PyPI package ${spec ?? "(unknown)"} via uvx`
          : `the container image ${spec ?? "(unknown)"} via docker`;
    warnings.push(
      `Downloads and runs ${runner} each time the server starts, as your user account, with the workspace as its working directory.`,
    );
    if (spec && (/@latest$/.test(spec) || !/@\d/.test(spec.replace(/^@/, "")))) {
      warnings.push("The version is not pinned: a later launch may run a newer release than the one you reviewed.");
    }
    const argRefs = new Set((entry.args ?? []).flatMap((a) => [...a.matchAll(/\$\{secret:([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!)));
    for (const name of argRefs) {
      warnings.push(`${name} is passed as a command-line argument, so other local users can see it in the process list.`);
    }
  } else {
    warnings.push(`Connects to ${new URL(catalog.url!).host} over ${catalog.transport.toUpperCase()}; requests carry the headers shown.`);
  }
  if (catalog.trust === "community") {
    warnings.push("Community server: not published by the service's vendor or the MCP project. Review its source before installing.");
  }
  if (catalog.origin === "registry") {
    warnings.push(`Listed by the remote registry ${registryUrl ?? ""}, not Viberon's bundled catalog.`.replace("  ", " "));
  }
  return warnings;
}

async function storedSecrets(serverName: string, catalog: CatalogEntry): Promise<McpSecretStatus[]> {
  return mcpSecretStatus(
    serverName,
    catalog.fields.filter((f) => f.secret).map((f) => f.name),
  );
}

function assertInstallable(catalog: CatalogEntry, existing: RawServerEntry | undefined): void {
  if (existing && existing.catalogId !== catalog.id) {
    throw new MarketplaceError(
      `A server named "${catalog.id}" already exists in your MCP settings. Remove it there first.`,
      409,
      "conflict",
    );
  }
}

/** Everything an install would do, without doing any of it. */
export async function planInstall(
  catalog: CatalogEntry,
  input: Record<string, unknown>,
  registryUrl: string | null = null,
): Promise<InstallPlan> {
  const serverName = catalog.id;
  const existing = (await getGlobalEntries())[serverName];
  assertInstallable(catalog, existing);
  const secrets = await storedSecrets(serverName, catalog);
  const stored = new Set(secrets.filter((s) => s.configured).map((s) => s.name));
  const { entry, missing, newSecrets } = buildInstallEntry(catalog, input, stored, existing);

  const env: PlanEnvVar[] = Object.entries(entry.env ?? {}).map(([name, value]) => {
    const isSecret = value.startsWith("${secret:");
    const status = secrets.find((s) => s.name === name);
    return {
      name,
      secret: isSecret,
      value: isSecret ? (newSecrets[name] ? "(new value, saved to the credentials store)" : (status?.masked ?? "(not set)")) : value,
    };
  });

  return {
    id: catalog.id,
    serverName,
    displayName: catalog.name,
    trust: catalog.trust,
    origin: catalog.origin,
    publisher: catalog.publisher,
    homepage: catalog.homepage,
    transport: catalog.transport,
    ...(entry.command
      ? {
          command: entry.command,
          args: entry.args ?? [],
          commandLine: [entry.command, ...(entry.args ?? [])].map(quoteArg).join(" "),
        }
      : {}),
    ...(entry.url ? { url: entry.url, headers: redactRecord(entry.headers ?? {}) } : {}),
    env,
    inheritedEnv: catalog.transport === "stdio" ? INHERITED_ENV : [],
    secrets: secrets.map((s) => (newSecrets[s.name] ? { ...s, configured: true, masked: "(new value)" } : s)),
    warnings: warningsFor(catalog, entry, registryUrl),
    missing,
    reinstall: Boolean(existing),
    planHash: hashEntry(catalog.id, entry),
  };
}

/* ----------------------------- install / manage ---------------------------- */

export interface InstalledServer {
  name: string;
  catalogId: string;
  enabled: boolean;
  trusted: boolean;
  transport: "stdio" | "http" | "sse";
  /** Non-secret form values, for prefilling a reconfigure. */
  values: Record<string, string>;
  secrets: McpSecretStatus[];
}

async function summarize(name: string, raw: RawServerEntry): Promise<InstalledServer> {
  const parsed = parseServerEntry(name, raw, "global");
  const refs = typeof parsed === "string" ? [] : secretRefs(parsed.transport);
  return {
    name,
    catalogId: raw.catalogId ?? name,
    enabled: raw.disabled !== true,
    trusted: raw.trusted === true,
    transport: typeof parsed === "string" ? "stdio" : parsed.transport.type,
    values: { ...(raw.catalogValues ?? {}) },
    secrets: await mcpSecretStatus(name, refs),
  };
}

/** Servers installed from the marketplace (global entries with `catalogId`). */
export async function listInstalled(): Promise<InstalledServer[]> {
  const entries = await getGlobalEntries();
  const out: InstalledServer[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    if (raw && typeof raw.catalogId === "string") out.push(await summarize(name, raw));
  }
  return out;
}

export interface InstallRequest {
  values?: Record<string, unknown>;
  confirm?: boolean;
  planHash?: string;
  registryUrl?: string | null;
}

/**
 * Write the reviewed plan. Refused unless `confirm` is true and `planHash`
 * matches what `planInstall` returns for the same input right now.
 */
export async function installServer(catalog: CatalogEntry, request: InstallRequest): Promise<InstalledServer> {
  const input = request.values ?? {};
  const plan = await planInstall(catalog, input, request.registryUrl ?? null);
  if (plan.missing.length > 0) {
    throw new MarketplaceError(`Missing required value${plan.missing.length === 1 ? "" : "s"}: ${plan.missing.join(", ")}`, 400, "invalid");
  }
  if (request.confirm !== true) {
    throw new MarketplaceError("Installing runs a third-party program. Review the plan and confirm.", 400, "not-confirmed");
  }
  if (!request.planHash || request.planHash !== plan.planHash) {
    throw new MarketplaceError("The install plan changed since you reviewed it. Review it again.", 409, "plan-changed");
  }

  const existing = (await getGlobalEntries())[catalog.id];
  const secrets = await storedSecrets(catalog.id, catalog);
  const stored = new Set(secrets.filter((s) => s.configured).map((s) => s.name));
  const { entry, newSecrets } = buildInstallEntry(catalog, input, stored, existing);
  const parsed = parseServerEntry(catalog.id, entry, "global");
  if (typeof parsed === "string") throw new MarketplaceError(parsed, 400, "invalid");

  for (const [name, value] of Object.entries(newSecrets)) await setMcpSecret(catalog.id, name, value);
  await setGlobalEntry(catalog.id, entry);
  // Pooled connections still hold the old command / secrets.
  await disconnectEverywhere(catalog.id);
  return summarize(catalog.id, entry);
}

async function installedEntry(name: string): Promise<RawServerEntry> {
  const raw = (await getGlobalEntries())[name];
  if (!raw || typeof raw.catalogId !== "string") {
    throw new MarketplaceError(`"${name}" is not installed from the marketplace.`, 404, "not-found");
  }
  return raw;
}

/** Remove the config entry, its stored secrets, and any live connection. */
export async function uninstallServer(name: string, catalog?: CatalogEntry): Promise<void> {
  const raw = await installedEntry(name);
  const parsed = parseServerEntry(name, raw, "global");
  const names = new Set([
    ...(typeof parsed === "string" ? [] : secretRefs(parsed.transport)),
    ...(catalog?.fields.filter((f) => f.secret).map((f) => f.name) ?? []),
  ]);
  await setGlobalEntry(name, null);
  for (const secret of names) await setMcpSecret(name, secret, null);
  await disconnectEverywhere(name);
}

export async function setServerEnabled(name: string, enabled: boolean): Promise<InstalledServer> {
  const raw = await installedEntry(name);
  const next: RawServerEntry = { ...raw };
  if (enabled) delete next.disabled;
  else next.disabled = true;
  await setGlobalEntry(name, next);
  if (!enabled) await disconnectEverywhere(name);
  return summarize(name, next);
}

/* ------------------------------ test connection ---------------------------- */

export const TEST_TIMEOUT_MS = 30_000;

export interface TestResult {
  ok: boolean;
  error?: string;
  timedOut?: boolean;
  tools: { name: string; description: string }[];
  serverInfo?: { name: string; version: string };
  logs: string[];
  durationMs: number;
}

export interface TestDeps {
  connect: typeof ensureConnected;
  disconnect: typeof disconnectServer;
  logs: typeof serverLogs;
}

const defaultDeps: TestDeps = { connect: ensureConnected, disconnect: disconnectServer, logs: serverLogs };

/** Replace every occurrence of a secret value (and its env-style form) in a log line. */
export function scrubSecrets(lines: string[], secrets: string[]): string[] {
  const values = secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  return lines.map((line) => values.reduce((out, value) => out.split(value).join("••••"), line));
}

/**
 * Start an installed server under a throwaway scope, list its tools, and
 * tear it down, all within `timeoutMs`. Works whether or not the server is
 * enabled, so a user can check a config before switching it on.
 */
export async function testServer(
  name: string,
  options: { cwd?: string | null; timeoutMs?: number; deps?: Partial<TestDeps> } = {},
): Promise<TestResult> {
  const deps = { ...defaultDeps, ...options.deps };
  const raw = await installedEntry(name);
  const parsed = parseServerEntry(name, raw, "global");
  if (typeof parsed === "string") throw new MarketplaceError(parsed, 400, "invalid");
  const config: McpServerConfig = { ...parsed, enabled: true };
  const secretValues = Object.values(await getMcpSecrets(name, secretRefs(config.transport)));

  const scope = `marketplace-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  const started = Date.now();
  const pending = deps.connect(scope, config, options.cwd ?? null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([pending, timeout]);
  clearTimeout(timer);

  const logs = () => scrubSecrets(deps.logs(scope, name).slice(-40), secretValues);
  if (outcome === "timeout") {
    const result: TestResult = {
      ok: false,
      timedOut: true,
      error: `No response within ${Math.round(timeoutMs / 1000)}s. The first launch of an npx/uvx server downloads it; try again.`,
      tools: [],
      logs: logs(),
      durationMs: Date.now() - started,
    };
    // The connect keeps going in the background; close it when it settles
    // so no child process is left behind.
    void pending.then(
      () => deps.disconnect(scope, name, true),
      () => deps.disconnect(scope, name, true),
    );
    return result;
  }

  const result: TestResult = {
    ok: outcome.status === "connected",
    ...(outcome.error ? { error: scrubSecrets([outcome.error], secretValues)[0] } : {}),
    tools: outcome.tools.map((t) => ({ name: t.name, description: (t.description ?? t.title ?? "").slice(0, 300) })),
    ...(outcome.serverInfo ? { serverInfo: outcome.serverInfo } : {}),
    logs: logs(),
    durationMs: Date.now() - started,
  };
  await deps.disconnect(scope, name, true);
  return result;
}
