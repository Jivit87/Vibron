/**
 * Host normalization: one canonical spelling per destination.
 *
 * Every host that reaches a policy decision goes through `normalizeHost`, so
 * `Example.COM.`, `example.com` and `xn--…` forms of the same name, or
 * `0x7f.1` and `127.0.0.1`, cannot be used to slip past a rule. The WHATWG
 * URL host parser does the heavy lifting (IDNA/punycode, IPv4 number forms,
 * IPv6 compression); we add trailing-dot stripping on top.
 */

import { formatIp, parseIp } from "./ip";

export interface EgressTarget {
  /** Canonical host: lowercase ASCII (punycode), no trailing dot, IPv6 unbracketed. */
  host: string;
  /** Destination port when known (explicit, or the scheme default). */
  port: number | null;
  /** URL scheme without the colon, when the target came from a URL. */
  scheme: string | null;
}

const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
  ssh: 22,
  git: 9418,
};

export function defaultPort(scheme: string | null | undefined): number | null {
  if (!scheme) return null;
  return DEFAULT_PORTS[scheme.toLowerCase().replace(/:$/, "")] ?? null;
}

/**
 * Canonicalize a bare host. Returns null for something that is not a valid
 * host at all (spaces, empty labels, a bad IPv6 literal …).
 */
export function normalizeHost(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  // Strip IPv6 brackets up front; re-add them for the URL parser.
  const bracketed = text.startsWith("[") && text.endsWith("]");
  if (bracketed) text = text.slice(1, -1);

  if (bracketed || text.includes(":")) {
    const ip = parseIp(text);
    return ip && ip.version === 6 ? formatIp(ip) : null;
  }

  // Trailing dots are the absolute-FQDN spelling of the same name.
  text = text.replace(/\.+$/, "");
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${text}/`);
  } catch {
    return null;
  }
  // The parser would have happily taken `user@host` or a path; we want a host.
  if (parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.replace(/\.+$/, "");
  if (!host) return null;
  if (host.startsWith("[")) {
    const ip = parseIp(host);
    return ip ? formatIp(ip) : null;
  }
  return host;
}

/** Target of an http(s)/ws/ftp/… URL. Null for unparseable URLs. */
export function targetFromUrl(input: string | URL): EgressTarget | null {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const host = normalizeHost(url.hostname);
  if (!host) return null;
  const port = url.port ? Number(url.port) : defaultPort(scheme);
  return { host, port, scheme };
}

/**
 * Parse `host`, `host:port`, `[v6]:port` or a bare IPv6 literal. The port
 * is optional. Returns null when the host part is invalid.
 */
export function parseHostPort(input: string): { host: string; port: number | null } | null {
  const text = input.trim();
  if (!text) return null;
  const bracket = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracket) {
    const host = normalizeHost(bracket[1]);
    const port = bracket[2] ? Number(bracket[2]) : null;
    if (!host || (port !== null && (port < 1 || port > 65535))) return null;
    return { host, port };
  }
  const colons = (text.match(/:/g) ?? []).length;
  if (colons > 1) {
    // Bare IPv6, no port possible without brackets.
    const host = normalizeHost(text);
    return host ? { host, port: null } : null;
  }
  const m = text.match(/^(.*?)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const host = normalizeHost(m[1]);
  const port = m[2] ? Number(m[2]) : null;
  if (!host || (port !== null && (port < 1 || port > 65535))) return null;
  return { host, port };
}

/** `host:port` for display and logs, bracketing IPv6. */
export function formatTarget(host: string, port: number | null): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return port ? `${h}:${port}` : h;
}
