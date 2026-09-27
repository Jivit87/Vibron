/**
 * Policy-checked HTTP fetch with an SSRF guard, for server-side fetches the
 * agent can steer (the browse tool, web search).
 *
 * Every hop is checked: redirects are followed by hand (`redirect: "manual"`)
 * and each `Location` goes through the same host decision and address check
 * as the first URL, so an allowed site cannot bounce the request to a
 * disallowed host or to 169.254.169.254.
 *
 * The address check resolves the hostname and inspects every address it
 * gets back. `fetch` then resolves again on its own, so a DNS server that
 * answers differently the second time (rebinding) can still win the race;
 * closing that needs a pinned-address dispatcher, which Node's built-in
 * fetch does not expose without an extra dependency. See docs/EGRESS.md.
 */

import { lookup as dnsLookup } from "node:dns/promises";

import { appendAudit, redactUrl } from "./audit";
import { targetFromUrl } from "./host";
import { isIpLiteral, METADATA_HOSTNAMES } from "./ip";
import { checkAddress, evaluateHost, type EffectiveEgressPolicy, type EgressSource } from "./policy";

/** Resolve a hostname to every address it has. */
export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

export interface EgressScope {
  policy: EffectiveEgressPolicy;
  source: EgressSource;
  /** Workspace folder for the audit log; null = the global log. */
  rootPath?: string | null;
  repoKey?: string;
  /** DNS seam for tests. */
  lookup?: Lookup;
  /** Set false to skip the audit log (dry runs from the settings UI). */
  audit?: boolean;
}

export interface UrlCheck {
  allowed: boolean;
  url: string;
  host: string;
  port: number | null;
  rule: string | null;
  reason: string;
  address?: string;
}

const ALLOWED_SCHEMES = new Set(["http", "https"]);

export interface HostCheck {
  allowed: boolean;
  host: string;
  port: number | null;
  rule: string | null;
  reason: string;
  /** First resolved address; every address was checked. */
  address?: string;
  /** All resolved addresses, when the check passed. */
  addresses?: string[];
}

/**
 * Host rules, then the SSRF guard on every address the name resolves to.
 * Shared by `checkUrl` (browse) and the egress proxy (sandbox, terminal).
 */
export async function decideHost(host: string, port: number | null, scope: EgressScope): Promise<HostCheck> {
  const decision = evaluateHost(scope.policy, host, port, scope.source);
  const base = { host: decision.host, port };
  if (!decision.allowed) return { ...base, allowed: false, rule: decision.rule, reason: decision.reason };

  if (METADATA_HOSTNAMES.has(decision.host) && decision.matchedKind !== "exact") {
    return {
      ...base,
      allowed: false,
      rule: "ssrf:metadata",
      reason: `${decision.host} is a cloud metadata endpoint; allowing it needs an allow rule naming it exactly`,
    };
  }

  let addresses: string[];
  if (isIpLiteral(decision.host)) {
    addresses = [decision.host];
  } else {
    try {
      addresses = await (scope.lookup ?? systemLookup)(decision.host);
    } catch (error) {
      return {
        ...base,
        allowed: false,
        rule: "dns",
        reason: `could not resolve ${decision.host}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (addresses.length === 0) {
      return { ...base, allowed: false, rule: "dns", reason: `${decision.host} did not resolve to any address` };
    }
  }

  // Every address must pass: a name that resolves to one public and one
  // private address is treated as the private one.
  for (const address of addresses) {
    const check = checkAddress(scope.policy, decision, address, port);
    if (!check.allowed) return { ...base, allowed: false, rule: check.rule, reason: check.reason, address };
  }
  return { ...base, allowed: true, rule: decision.rule, reason: decision.reason, address: addresses[0], addresses };
}

async function decideUrl(url: URL, scope: EgressScope): Promise<UrlCheck> {
  const shown = redactUrl(url);
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { allowed: false, url: shown, host: url.hostname, port: null, rule: "scheme", reason: `only http and https URLs can be fetched, not ${scheme}:` };
  }
  const target = targetFromUrl(url);
  if (!target) {
    return { allowed: false, url: shown, host: url.hostname, port: null, rule: "invalid-url", reason: `"${shown}" has no valid host` };
  }
  const { host, port } = target;
  const check = await decideHost(host, port, scope);
  return { allowed: check.allowed, url: shown, host: check.host, port, rule: check.rule, reason: check.reason, address: check.address };
}

/** Check one URL against the policy (host rules + SSRF guard) and log it. */
export async function checkUrl(input: string | URL, scope: EgressScope): Promise<UrlCheck> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return { allowed: false, url: String(input).slice(0, 300), host: "", port: null, rule: "invalid-url", reason: "not a valid URL" };
  }
  const result = await decideUrl(url, scope);
  if (scope.audit !== false) {
    await appendAudit(scope.rootPath, {
      host: result.host,
      port: result.port,
      decision: result.allowed ? "allow" : "deny",
      source: scope.source,
      rule: result.rule,
      reason: result.reason,
      url: result.url,
      address: result.address,
      repoKey: scope.repoKey || undefined,
    });
  }
  return result;
}

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type EgressFetchResult =
  | { ok: true; response: Response; finalUrl: string; hops: string[] }
  | { ok: false; blocked: UrlCheck; hops: string[] };

export interface EgressFetchOptions extends EgressScope {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

/**
 * `fetch` that re-checks the policy on every redirect hop. Returns the
 * final response, or the check that blocked a hop. Network errors throw,
 * as `fetch` does.
 */
export async function egressFetch(
  input: string,
  init: RequestInit,
  options: EgressFetchOptions,
): Promise<EgressFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const hops: string[] = [];
  let url = input;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;

  for (let hop = 0; ; hop++) {
    const check = await checkUrl(url, options);
    hops.push(check.url);
    if (!check.allowed) return { ok: false, blocked: check, hops };

    const response = await doFetch(url, { ...init, method, body, redirect: "manual" });
    const location = response.headers?.get?.("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { ok: true, response, finalUrl: url, hops };
    }
    // Drop the redirect body; we only need the header.
    try {
      await response.body?.cancel();
    } catch {
      // Already consumed or not a stream.
    }
    if (hop >= maxRedirects) {
      return {
        ok: false,
        blocked: {
          allowed: false,
          url: redactUrl(url),
          host: check.host,
          port: check.port,
          rule: "redirect-limit",
          reason: `more than ${maxRedirects} redirects`,
        },
        hops,
      };
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return {
        ok: false,
        blocked: { allowed: false, url: redactUrl(url), host: check.host, port: check.port, rule: "invalid-url", reason: `invalid redirect target "${location.slice(0, 200)}"` },
        hops,
      };
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    url = next.href;
  }
}
