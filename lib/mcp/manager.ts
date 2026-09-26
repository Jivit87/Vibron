/**
 * MCP connection manager.
 *
 * One pooled client per (workspace, server). Connections are lazy: nothing
 * is spawned until an agent run or an explicit test/restart needs the
 * server. Concurrent callers share one in-flight connect, so a wave of six
 * agents starting together launches each server exactly once.
 *
 * The pool lives on globalThis so dev-mode HMR does not orphan child
 * processes, and stdio children are killed when this process exits.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";

import type { McpToolInfo } from "@/lib/mcp/bridge";
import { getMcpSecrets } from "@/lib/ai/credentials";
import {
  configFingerprint,
  expandSecretRefs,
  expandTransport,
  secretRefs,
  type McpServerConfig,
} from "@/lib/mcp/config";
import { scrubEnv } from "@/lib/terminal/safety";

export type McpStatus = "idle" | "connecting" | "connected" | "error" | "closed";

export const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_LOG_LINES = 400;

interface Connection {
  key: string;
  name: string;
  fingerprint: string;
  status: McpStatus;
  error?: string;
  client?: Client;
  transport?: Transport;
  pid?: number | null;
  tools: McpToolInfo[];
  serverInfo?: { name: string; version: string };
  logs: string[];
  connecting?: Promise<Connection>;
  connectedAt?: number;
  /** Bumped on every (re)connect so stale onclose handlers are ignored. */
  generation: number;
}

const POOL_KEY = Symbol.for("viberon.mcp.pool");
type GlobalWithPool = typeof globalThis & { [POOL_KEY]?: Map<string, Connection> };
const host = globalThis as GlobalWithPool;
const pool: Map<string, Connection> = host[POOL_KEY] ?? new Map();
host[POOL_KEY] = pool;

export const poolKey = (scope: string, name: string) => `${scope}\u0000${name}`;

function log(conn: Connection, line: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  for (const part of line.split(/\r?\n/)) {
    if (!part.trim()) continue;
    conn.logs.push(`${stamp} ${part}`);
  }
  if (conn.logs.length > MAX_LOG_LINES) conn.logs.splice(0, conn.logs.length - MAX_LOG_LINES);
}

function entry(scope: string, config: McpServerConfig): Connection {
  const key = poolKey(scope, config.name);
  let conn = pool.get(key);
  if (!conn) {
    conn = {
      key,
      name: config.name,
      fingerprint: configFingerprint(config),
      status: "idle",
      tools: [],
      logs: [],
      generation: 0,
    };
    pool.set(key, conn);
  }
  return conn;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Values for the `${secret:NAME}` references in a config. Only the user's
 * own global list may reference stored secrets: a repo file naming
 * `${secret:…}` gets nothing (and a log line saying why).
 */
async function loadSecrets(config: McpServerConfig, conn: Connection): Promise<Record<string, string>> {
  const names = secretRefs(config.transport);
  if (names.length === 0) return {};
  if (config.source !== "global") {
    log(conn, "[viberon] ${secret:…} references are only honoured for servers in user settings");
    return {};
  }
  return getMcpSecrets(config.name, names);
}

function buildTransport(
  config: McpServerConfig,
  cwd: string | null,
  conn: Connection,
  secrets: Record<string, string> = {},
): Transport {
  const missing = new Set<string>();
  // `${VAR}` in a repo-supplied config must not be able to pull the app's
  // API keys into a header or argument bound for a third party.
  const env = config.source === "global" ? process.env : scrubEnv(process.env);
  // Environment first, secrets second: a secret value that happens to
  // contain `${…}` is never itself expanded.
  const t = expandSecretRefs(expandTransport(config.transport, env, missing), secrets, missing);
  if (missing.size > 0) {
    log(conn, `[viberon] unset environment variables: ${[...missing].join(", ")}`);
  }

  if (t.type === "stdio") {
    const transport = new StdioClientTransport({
      command: t.command,
      args: t.args,
      // A safe inherited subset (PATH, HOME, …) plus what the config sets.
      // Deliberately not the full process env: that would hand every
      // provider API key to a third-party server.
      env: { ...getDefaultEnvironment(), ...t.env },
      cwd: t.cwd ? path.resolve(cwd ?? process.cwd(), t.cwd) : (cwd ?? process.cwd()),
      stderr: "pipe",
    });
    return transport;
  }

  const url = new URL(t.url);
  const requestInit: RequestInit = { headers: t.headers };
  return t.type === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

async function refreshTools(conn: Connection): Promise<void> {
  if (!conn.client) return;
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  // Follow pagination, with a hard cap against a misbehaving server.
  for (let page = 0; page < 20; page += 1) {
    const result = await conn.client.listTools(cursor ? { cursor } : undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    tools.push(...(result.tools as McpToolInfo[]));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  conn.tools = tools;
}

async function connect(
  scope: string,
  config: McpServerConfig,
  cwd: string | null,
  conn: Connection,
): Promise<Connection> {
  conn.generation += 1;
  const generation = conn.generation;
  conn.status = "connecting";
  conn.error = undefined;
  conn.fingerprint = configFingerprint(config);
  log(conn, `[viberon] connecting (${config.transport.type})`);

  let transport: Transport | undefined;
  try {
    transport = buildTransport(config, cwd, conn, await loadSecrets(config, conn));
    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on("data", (chunk: Buffer) => log(conn, chunk.toString("utf8")));
    }
    const client = new Client({ name: "viberon", version: "0.1.0" }, { capabilities: {} });
    client.onerror = (error) => log(conn, `[viberon] transport error: ${error.message}`);
    client.onclose = () => {
      if (conn.generation !== generation) return;
      log(conn, "[viberon] connection closed");
      if (conn.status === "connected") conn.status = "closed";
      conn.client = undefined;
      conn.transport = undefined;
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log(conn, "[viberon] server reported tool list changed");
      await refreshTools(conn).catch((error) =>
        log(conn, `[viberon] refreshing tools failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    });

    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
    conn.client = client;
    conn.transport = transport;
    conn.pid = transport instanceof StdioClientTransport ? transport.pid : null;
    const info = client.getServerVersion();
    conn.serverInfo = info ? { name: info.name, version: info.version } : undefined;
    await refreshTools(conn);
    conn.status = "connected";
    conn.connectedAt = Date.now();
    log(
      conn,
      `[viberon] connected${info ? ` to ${info.name} ${info.version}` : ""} — ${conn.tools.length} tool${conn.tools.length === 1 ? "" : "s"}`,
    );
    ensureExitHooks();
    return conn;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    conn.status = "error";
    conn.error = message;
    conn.tools = [];
    conn.client = undefined;
    conn.transport = undefined;
    log(conn, `[viberon] failed: ${message}`);
    await transport?.close().catch(() => undefined);
    return conn;
  }
}

/**
 * Get a live connection, connecting (or reconnecting after a crash or a
 * config change) if needed. Never throws — a failed server comes back with
 * status "error" and the message, so one bad server cannot sink a run.
 */
export async function ensureConnected(
  scope: string,
  config: McpServerConfig,
  cwd: string | null,
): Promise<Connection> {
  const conn = entry(scope, config);
  if (conn.connecting) return conn.connecting;
  const stale = conn.fingerprint !== configFingerprint(config);
  if (conn.status === "connected" && conn.client && !stale) return conn;
  if (stale && conn.client) {
    log(conn, "[viberon] configuration changed — reconnecting");
    await closeConnection(conn);
  }
  conn.connecting = connect(scope, config, cwd, conn).finally(() => {
    conn.connecting = undefined;
  });
  return conn.connecting;
}

async function closeConnection(conn: Connection): Promise<void> {
  conn.generation += 1;
  const client = conn.client;
  conn.client = undefined;
  conn.transport = undefined;
  conn.pid = undefined;
  conn.tools = [];
  if (client) await client.close().catch(() => undefined);
}

export async function restartServer(
  scope: string,
  config: McpServerConfig,
  cwd: string | null,
): Promise<Connection> {
  const conn = entry(scope, config);
  if (conn.connecting) await conn.connecting.catch(() => undefined);
  await closeConnection(conn);
  log(conn, "[viberon] restarting");
  conn.status = "idle";
  return ensureConnected(scope, config, cwd);
}

export async function disconnectServer(scope: string, name: string, forget = false): Promise<void> {
  const conn = pool.get(poolKey(scope, name));
  if (!conn) return;
  await closeConnection(conn);
  conn.status = "idle";
  if (forget) pool.delete(conn.key);
}

/** Drop every pooled connection to `name`, across all workspace scopes. */
export async function disconnectEverywhere(name: string): Promise<void> {
  const matches = [...pool.values()].filter((conn) => conn.name === name);
  await Promise.all(
    matches.map(async (conn) => {
      await closeConnection(conn);
      conn.status = "idle";
    }),
  );
}

export async function callServerTool(
  scope: string,
  config: McpServerConfig,
  cwd: string | null,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const conn = await ensureConnected(scope, config, cwd);
  if (!conn.client) throw new Error(conn.error ?? `server "${config.name}" is not connected`);
  log(conn, `[viberon] call ${tool}`);
  return conn.client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: config.timeoutMs,
    signal,
    resetTimeoutOnProgress: true,
  });
}

export interface ConnectionSnapshot {
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  serverInfo?: { name: string; version: string };
  connectedAt?: number;
  pid?: number | null;
  logLines: number;
}

export function connectionSnapshot(scope: string, name: string): ConnectionSnapshot {
  const conn = pool.get(poolKey(scope, name));
  if (!conn) return { status: "idle", tools: [], logLines: 0 };
  return {
    status: conn.status,
    error: conn.error,
    tools: conn.tools,
    serverInfo: conn.serverInfo,
    connectedAt: conn.connectedAt,
    pid: conn.pid,
    logLines: conn.logs.length,
  };
}

export function serverLogs(scope: string, name: string): string[] {
  return [...(pool.get(poolKey(scope, name))?.logs ?? [])];
}

export async function shutdownAll(): Promise<void> {
  await Promise.all([...pool.values()].map((conn) => closeConnection(conn)));
  pool.clear();
}

/* ------------------------------ exit hooks -------------------------------- */

const HOOKS_KEY = Symbol.for("viberon.mcp.exit-hooks");
type GlobalWithHooks = typeof globalThis & { [HOOKS_KEY]?: boolean };

/** Synchronous best-effort kill — the only thing allowed inside "exit". */
function killChildren(): void {
  for (const conn of pool.values()) {
    if (conn.pid) {
      try {
        process.kill(conn.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

function ensureExitHooks(): void {
  const g = globalThis as GlobalWithHooks;
  if (g[HOOKS_KEY]) return;
  g[HOOKS_KEY] = true;
  process.once("exit", killChildren);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      killChildren();
      // Only re-raise when nobody else handles the signal: installing a
      // listener disables Node's default exit, and we must not swallow it.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
}
