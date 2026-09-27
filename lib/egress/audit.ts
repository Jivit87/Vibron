/**
 * Egress audit log: append-only JSON Lines at `<workspace>/.viberon/egress.log`.
 *
 * One line per decision, written with O_APPEND so concurrent writers never
 * interleave within a line. Runs without a workspace folder (the global
 * scope) log under `$VIBERON_STORE_DIR` (or the server's cwd) instead.
 * When the file passes MAX_BYTES it is renamed to `egress.log.1` and a new
 * file is started, so the log cannot fill a disk; nothing is ever edited
 * in place.
 *
 * URLs are logged without their query string and fragment, which is where
 * tokens usually hide. Commands are truncated.
 */

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import type { EgressSource } from "./policy";

export type AuditDecision = "allow" | "deny" | "ask";

export interface EgressAuditEntry {
  ts: string;
  host: string;
  port: number | null;
  decision: AuditDecision;
  source: EgressSource;
  /** The rule that decided (`mode:allowlist`, `deny *.x.test (global)`, `ssrf:metadata` …). */
  rule: string | null;
  reason?: string;
  /** Scheme, host and path only. */
  url?: string;
  command?: string;
  /** Resolved address, when the SSRF guard looked at one. */
  address?: string;
  repoKey?: string;
}

export const LOG_RELATIVE_PATH = path.join(".viberon", "egress.log");
const MAX_BYTES = 5 * 1024 * 1024;

export function auditLogPath(rootPath: string | null | undefined): string {
  const base = rootPath || process.env.VIBERON_STORE_DIR || process.cwd();
  return path.join(base, LOG_RELATIVE_PATH);
}

/** Strip credentials, query and fragment from a URL before logging it. */
export function redactUrl(input: string | URL): string {
  try {
    const url = typeof input === "string" ? new URL(input) : new URL(input.href);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return String(input).split(/[?#]/)[0].slice(0, 300);
  }
}

// Serialize writes per file so rotation and appends cannot race in-process.
const queues = new Map<string, Promise<void>>();

export function appendAudit(
  rootPath: string | null | undefined,
  entry: Omit<EgressAuditEntry, "ts"> & { ts?: string },
): Promise<void> {
  if (process.env.VIBERON_EGRESS_AUDIT === "off") return Promise.resolve();
  // Like the settings store: tests never write the process-global log into
  // the repo; a test that wants a log passes a rootPath.
  if (!rootPath && process.env.VITEST) return Promise.resolve();
  const file = auditLogPath(rootPath);
  const { ts, ...rest } = entry;
  const line: EgressAuditEntry = {
    ts: ts ?? new Date().toISOString(),
    ...rest,
    ...(rest.command ? { command: rest.command.slice(0, 300) } : {}),
  };
  const prior = queues.get(file) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
      await appendFile(file, JSON.stringify(line) + "\n", { encoding: "utf8", flag: "a" });
    })
    // Logging must never break the request it describes.
    .catch(() => undefined);
  queues.set(file, next);
  void next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  });
  return next;
}

export interface AuditQuery {
  limit?: number;
  decision?: AuditDecision;
  source?: EgressSource;
}

/** Most recent entries first. Malformed lines are skipped. */
export async function readAudit(rootPath: string | null | undefined, query: AuditQuery = {}): Promise<EgressAuditEntry[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
  let text: string;
  try {
    text = await readFile(auditLogPath(rootPath), "utf8");
  } catch {
    return [];
  }
  const out: EgressAuditEntry[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: EgressAuditEntry;
    try {
      entry = JSON.parse(line) as EgressAuditEntry;
    } catch {
      continue;
    }
    if (!entry || typeof entry.host !== "string" || typeof entry.decision !== "string") continue;
    if (query.decision && entry.decision !== query.decision) continue;
    if (query.source && entry.source !== query.source) continue;
    out.push(entry);
  }
  return out;
}
