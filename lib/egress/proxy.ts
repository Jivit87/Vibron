/**
 * The egress proxy: a small HTTP/HTTPS (CONNECT) forward proxy that applies
 * the egress policy to processes Viberon starts — sandboxed containers and,
 * when the policy is not "open", commands run directly on the host.
 *
 * - Clients authenticate with a per-(workspace, source) token carried in
 *   the proxy URL (`http://viberon:<token>@127.0.0.1:<port>`), so the proxy
 *   knows whose policy to apply and random local processes cannot use it.
 * - Every CONNECT / request is decided with `decideHost` (rules + SSRF
 *   guard) and logged to that workspace's audit log.
 * - The upstream connection goes to the *address that was checked*, not a
 *   fresh DNS answer, so DNS rebinding cannot swap the destination.
 * - HTTPS is tunnelled, never intercepted: the proxy sees the host and port
 *   only.
 *
 * It only binds 127.0.0.1 unless `VIBERON_EGRESS_PROXY_HOST` says otherwise
 * (on Linux, a sandbox container reaches the host at the docker0 gateway,
 * so that is where it has to listen for the sandbox case).
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";

import { appendAudit, redactUrl } from "./audit";
import { decideHost, type HostCheck, type Lookup } from "./fetch";
import { parseHostPort, targetFromUrl } from "./host";
import { withApprovedHosts, type EffectiveEgressPolicy, type EgressSource } from "./policy";

export interface ProxyClient {
  repoKey: string;
  rootPath: string | null;
  source: EgressSource;
  /** Hosts a person approved for this one command (allowlist mode). */
  allowHosts?: string[];
}

export interface EgressProxyOptions {
  /** Policy for a workspace. Default: the stored effective policy. */
  policyFor?: (repoKey: string) => Promise<EffectiveEgressPolicy>;
  lookup?: Lookup;
  host?: string;
  port?: number;
  /** Skip the audit log (tests). */
  audit?: boolean;
  /** How long a workspace's policy is cached. Default 5s. */
  policyTtlMs?: number;
}

export interface EgressProxy {
  host: string;
  port: number;
  /** Stable token for a client; registering twice returns the same token. */
  tokenFor(client: ProxyClient): string;
  /** `http://viberon:<token>@<host>:<port>` as seen from `reachableAs`. */
  urlFor(client: ProxyClient, reachableAs?: string): string;
  close(): Promise<void>;
}

const POLICY_TTL_MS = 5_000;

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const tokens = new Map<string, ProxyClient>();
  const byClient = new Map<string, string>();
  const cache = new Map<string, { at: number; policy: EffectiveEgressPolicy }>();

  const policyFor =
    options.policyFor ??
    (async (repoKey: string) => (await import("./settings")).loadEffectivePolicy(repoKey));

  async function policy(repoKey: string): Promise<EffectiveEgressPolicy> {
    const hit = cache.get(repoKey);
    if (hit && Date.now() - hit.at < (options.policyTtlMs ?? POLICY_TTL_MS)) return hit.policy;
    const fresh = await policyFor(repoKey);
    cache.set(repoKey, { at: Date.now(), policy: fresh });
    return fresh;
  }

  function authenticate(header: string | undefined): ProxyClient | null {
    if (!header) return null;
    const m = header.match(/^Basic\s+(.+)$/i);
    if (!m) return null;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const token = decoded.slice(decoded.indexOf(":") + 1);
    return tokens.get(token) ?? null;
  }

  async function decide(client: ProxyClient, host: string, port: number, logUrl: string): Promise<HostCheck> {
    const check = await decideHost(host, port, {
      policy: client.allowHosts?.length
        ? withApprovedHosts(await policy(client.repoKey), client.allowHosts)
        : await policy(client.repoKey),
      source: client.source,
      lookup: options.lookup,
    });
    if (options.audit !== false) {
      await appendAudit(client.rootPath, {
        host: check.host,
        port,
        decision: check.allowed ? "allow" : "deny",
        source: client.source,
        rule: check.rule ? `${check.rule} [proxy]` : "[proxy]",
        reason: check.reason,
        url: logUrl,
        address: check.address,
        repoKey: client.repoKey || undefined,
      });
    }
    return check;
  }

  const refuse = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      ...(status === 407 ? { "proxy-authenticate": 'Basic realm="viberon-egress"' } : {}),
      "x-viberon-egress": "blocked",
    });
    res.end(`${message}\n`);
  };

  // Open tunnels, so close() can end them instead of waiting on them.
  const tunnels = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    const client = authenticate(req.headers["proxy-authorization"]);
    if (!client) return refuse(res, 407, "Viberon egress proxy: authentication required");
    const target = req.url ? targetFromUrl(req.url) : null;
    if (!target || target.scheme !== "http" || !req.url) {
      return refuse(res, 400, "Viberon egress proxy: expected an absolute http:// URL (use CONNECT for https)");
    }
    const port = target.port ?? 80;
    let check: HostCheck;
    try {
      check = await decide(client, target.host, port, redactUrl(req.url));
    } catch (error) {
      return refuse(res, 502, `Viberon egress proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!check.allowed || !check.address) return refuse(res, 403, `Blocked by Viberon egress policy: ${check.reason}`);

    const url = new URL(req.url);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(
      {
        host: check.address,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) refuse(res, 502, `Viberon egress proxy: ${error.message}`);
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    const deny = (status: string, message: string) => {
      socket.end(
        `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nx-viberon-egress: blocked\r\n` +
          (status.startsWith("407") ? 'proxy-authenticate: Basic realm="viberon-egress"\r\n' : "") +
          `\r\n${message}\n`,
      );
    };
    const client = authenticate(req.headers["proxy-authorization"]);
    if (!client) return deny("407 Proxy Authentication Required", "Viberon egress proxy: authentication required");
    const hp = req.url ? parseHostPort(req.url) : null;
    if (!hp || !hp.port) return deny("400 Bad Request", "Viberon egress proxy: CONNECT needs host:port");
    let check: HostCheck;
    try {
      check = await decide(client, hp.host, hp.port, `connect://${req.url}`);
    } catch (error) {
      return deny("502 Bad Gateway", `Viberon egress proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!check.allowed || !check.address) return deny("403 Forbidden", `Blocked by Viberon egress policy: ${check.reason}`);

    const upstream = net.connect(hp.port, check.address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      if (socket.writable) deny("502 Bad Gateway", `Viberon egress proxy: ${error.message}`);
      socket.destroy();
    });
    socket.on("close", () => upstream.destroy());
  });

  const bindHost = options.host ?? process.env.VIBERON_EGRESS_PROXY_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The proxy must never keep a CLI run alive on its own.
  server.unref();
  const address = server.address() as net.AddressInfo;

  const clientKey = (c: ProxyClient) =>
    `${c.source}\u0000${c.repoKey}\u0000${c.rootPath ?? ""}\u0000${[...(c.allowHosts ?? [])].sort().join(",")}`;

  const proxy: EgressProxy = {
    host: bindHost,
    port: address.port,
    tokenFor(client) {
      const key = clientKey(client);
      const existing = byClient.get(key);
      if (existing) return existing;
      const token = randomBytes(18).toString("hex");
      tokens.set(token, { ...client });
      byClient.set(key, token);
      return token;
    },
    urlFor(client, reachableAs) {
      const host = reachableAs ?? (bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost);
      return `http://viberon:${proxy.tokenFor(client)}@${host}:${address.port}`;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections();
      });
    },
  };
  return proxy;
}

/* ------------------------------ shared instance ---------------------------- */

const PROXY_KEY = Symbol.for("viberon.egress.proxy");
type GlobalWithProxy = typeof globalThis & { [PROXY_KEY]?: Promise<EgressProxy> };

/** The process-wide proxy, started on first use (survives dev-mode HMR). */
export function sharedEgressProxy(): Promise<EgressProxy> {
  const g = globalThis as GlobalWithProxy;
  if (!g[PROXY_KEY]) {
    g[PROXY_KEY] = startEgressProxy().catch((error) => {
      delete g[PROXY_KEY];
      throw error;
    });
  }
  return g[PROXY_KEY];
}

/** Hosts that stay direct: the machine itself (dev servers, local tools). */
export const NO_PROXY = "localhost,127.0.0.1,::1,.localhost";

/** Standard proxy variables (both spellings; tools disagree on case). */
export function proxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY,
    no_proxy: NO_PROXY,
    // npm reads its own config names from the environment too.
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
  };
}
