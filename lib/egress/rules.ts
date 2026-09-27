/**
 * Host patterns: parsing and matching.
 *
 * Syntax (one pattern per rule):
 *
 *   example.com            exactly that host, any port
 *   example.com:8443       that host, only port 8443
 *   *.example.com          any subdomain at any depth — NOT example.com itself
 *   *.example.com:443      subdomains, port 443 only
 *   203.0.113.7[:port]     an IPv4 literal
 *   [2001:db8::1][:port]   an IPv6 literal (bare `2001:db8::1` works without a port)
 *   10.0.0.0/8, fd00::/8   a CIDR range (no port)
 *   *                      every host (rarely what you want outside a deny rule)
 *   https://example.com    a pasted URL: its host, and its port only if written
 *
 * Hosts are normalized the same way targets are (case, punycode, trailing
 * dot, IPv4 number forms, IPv6 compression), so a rule and a request for
 * the same place always compare equal.
 */

import { normalizeHost, parseHostPort } from "./host";
import { cidrContains, ipEquals, parseCidr, parseIp, type Cidr, type ParsedIp } from "./ip";

export type PatternKind = "any" | "exact" | "wildcard" | "ip" | "cidr";

export interface HostPattern {
  kind: PatternKind;
  /** The rule as the user wrote it. */
  source: string;
  /** Exact host, or the suffix for wildcards (without the leading `*.`). */
  host: string | null;
  ip: ParsedIp | null;
  cidr: Cidr | null;
  port: number | null;
}

export function parsePattern(input: string): HostPattern | string {
  const source = input.trim();
  if (!source) return "Pattern is empty.";
  const base = { source, host: null, ip: null, cidr: null, port: null };

  if (source.includes("://")) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return `"${source}" is not a valid URL.`;
    }
    const host = normalizeHost(url.hostname);
    if (!host) return `"${source}" has no valid host.`;
    return finish({ ...base, host, port: url.port ? Number(url.port) : null });
  }

  const any = source.match(/^\*(?::(\d{1,5}))?$/);
  if (any) {
    const port = any[1] ? Number(any[1]) : null;
    if (port !== null && (port < 1 || port > 65535)) return `Port out of range in "${source}".`;
    return { ...base, kind: "any", port };
  }

  if (source.startsWith("*.")) {
    const rest = parseHostPort(source.slice(2));
    if (!rest) return `"${source}" is not a valid wildcard pattern.`;
    if (parseIp(rest.host)) return `Wildcards apply to domain names, not IP addresses ("${source}").`;
    if (rest.host.includes("*")) return `Only a single leading "*." is supported ("${source}").`;
    return { ...base, kind: "wildcard", host: rest.host, port: rest.port };
  }
  if (source.includes("*")) return `Only a single leading "*." is supported ("${source}").`;

  if (source.includes("/")) {
    const cidr = parseCidr(source.replace(/^\[|\](?=\/)/g, ""));
    if (!cidr) return `"${source}" is not a valid CIDR range.`;
    return { ...base, kind: "cidr", cidr };
  }

  const hp = parseHostPort(source);
  if (!hp) return `"${source}" is not a valid host.`;
  return finish({ ...base, host: hp.host, port: hp.port });
}

function finish(p: Omit<HostPattern, "kind" | "ip"> & { ip?: ParsedIp | null }): HostPattern {
  const ip = p.host ? parseIp(p.host) : null;
  if (ip) return { ...p, kind: "ip", ip, cidr: null };
  return { ...p, kind: "exact", ip: null, cidr: null };
}

/** Does `pattern` cover `host` (already normalized) on `port`? */
export function matchPattern(pattern: HostPattern, host: string, port: number | null): boolean {
  if (pattern.port !== null && pattern.port !== port) return false;
  switch (pattern.kind) {
    case "any":
      return true;
    case "exact":
      return host === pattern.host;
    case "wildcard":
      return host.endsWith(`.${pattern.host}`);
    case "ip": {
      const target = parseIp(host);
      return Boolean(target && pattern.ip && ipEquals(target, pattern.ip));
    }
    case "cidr": {
      const target = parseIp(host);
      return Boolean(target && pattern.cidr && cidrContains(pattern.cidr, target));
    }
  }
}

/** Does `pattern` name this resolved address specifically (IP or CIDR rule)? */
export function matchAddress(pattern: HostPattern, ip: ParsedIp, port: number | null): boolean {
  if (pattern.port !== null && pattern.port !== port) return false;
  if (pattern.kind === "ip" && pattern.ip) return ipEquals(pattern.ip, ip);
  if (pattern.kind === "cidr" && pattern.cidr) return cidrContains(pattern.cidr, ip);
  return false;
}

