/**
 * Local-API request guard, used by `middleware.ts`.
 *
 * The API can run shell commands and write files, and it listens on
 * localhost — so any web page the user visits can try to reach it. Browsers
 * only protect us if we check what they tell us:
 *
 *  - **Host** must be a loopback name. Defeats DNS rebinding (an attacker's
 *    domain re-resolving to 127.0.0.1 still carries its own Host header).
 *  - **Origin**, when present, must be exactly our own origin. Browsers
 *    always send it on cross-origin requests and on every POST/PUT/PATCH/
 *    DELETE, so this is the core CSRF defence.
 *  - **Sec-Fetch-Site** must be `same-origin` or `none` when present. This
 *    also catches `same-site` requests from another localhost port, and GETs
 *    (which carry no Origin).
 *  - **Content-Type** must be JSON on body-carrying mutations. A `text/plain`
 *    no-cors POST is a "simple request" that skips CORS preflight entirely;
 *    requiring JSON forces a preflight we never answer.
 *
 * Non-browser clients (curl, the Electron main process) send no Origin and
 * no Sec-Fetch-* headers and are allowed — a web page cannot suppress them.
 *
 * Pure and dependency-free so it runs in the edge middleware runtime and is
 * trivially table-testable.
 */

export interface GuardInput {
  method: string;
  pathname: string;
  headers: Headers;
}

export interface GuardRejection {
  status: 403 | 415;
  error: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function extraAllowedHosts(): Set<string> {
  const raw =
    typeof process !== "undefined" ? process.env?.VIBERON_ALLOWED_HOSTS : undefined;
  return new Set(
    (raw ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Split `host[:port]`, handling bracketed IPv6. Returns null if malformed. */
export function parseHostHeader(
  value: string,
): { hostname: string; port: string } | null {
  const host = value.trim().toLowerCase();
  if (!host || /[\s/@?#\\]/.test(host)) return null;
  const match = host.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) return null;
  return { hostname: match[1], port: match[2] ?? "" };
}

export function isAllowedHost(value: string | null): boolean {
  if (!value) return false;
  const parsed = parseHostHeader(value);
  if (!parsed) return false;
  return (
    LOOPBACK_HOSTS.has(parsed.hostname) || extraAllowedHosts().has(parsed.hostname)
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_REQUIRED_JSON = new Set(["POST", "PUT", "PATCH"]);

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

function hasBody(headers: Headers): boolean {
  const length = headers.get("content-length");
  if (length !== null && length.trim() !== "" && Number(length) > 0) return true;
  return headers.has("transfer-encoding");
}

export function guardRequest(input: GuardInput): GuardRejection | null {
  const { headers } = input;
  const method = input.method.toUpperCase();
  const host = headers.get("host");

  if (!isAllowedHost(host)) {
    return { status: 403, error: "Forbidden: host is not a loopback address" };
  }

  if (!input.pathname.startsWith("/api/") && input.pathname !== "/api") {
    return null;
  }

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    const site = fetchSite.trim().toLowerCase();
    if (site !== "same-origin" && site !== "none") {
      return { status: 403, error: "Forbidden: cross-site request" };
    }
  }

  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        originHost = parsed.host.toLowerCase();
      }
    } catch {
      originHost = null;
    }
    // `new URL` drops default ports; normalise the Host header the same way.
    const normalizedHost = (host ?? "").trim().toLowerCase().replace(/:(80|443)$/, "");
    if (!originHost || originHost !== normalizedHost) {
      return { status: 403, error: "Forbidden: cross-origin request" };
    }
  }

  if (MUTATING.has(method)) {
    const needsJson = BODY_REQUIRED_JSON.has(method) || hasBody(headers);
    if (needsJson && !isJsonContentType(headers.get("content-type"))) {
      return { status: 415, error: "Unsupported Media Type: use application/json" };
    }
  }

  return null;
}
