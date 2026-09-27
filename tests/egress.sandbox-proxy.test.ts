import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareProcessEgress } from "@/lib/egress";
import { readAudit } from "@/lib/egress/audit";
import { DEFAULT_EGRESS_POLICY, resolvePolicy, type EgressPolicy } from "@/lib/egress/policy";
import { proxyEnv, startEgressProxy, type EgressProxy } from "@/lib/egress/proxy";
import { applySandboxPlan, deriveSandboxNetwork, stricterNetwork } from "@/lib/egress/sandbox";
import { buildRunCommand, type SandboxConfig } from "@/lib/sandbox";

/** A sandbox request as the tool context carries it. */
const sandbox = (network?: SandboxConfig["network"]): SandboxConfig => ({ enabled: true, network });

const policy = (patch: Partial<EgressPolicy> = {}) => resolvePolicy({ ...DEFAULT_EGRESS_POLICY, ...patch }, null);

describe("sandbox network derivation", () => {
  it("deny → no network, no proxy", () => {
    expect(deriveSandboxNetwork(policy({ mode: "deny" }))).toMatchObject({ network: "none", useProxy: false });
  });

  it("allowlist → bridge through the proxy, listing presets and allow rules", () => {
    const plan = deriveSandboxNetwork(
      policy({ mode: "allowlist", presets: ["packageRegistries"], rules: [{ action: "allow", pattern: "*.corp.example" }, { action: "deny", pattern: "x.test" }] }),
    );
    expect(plan).toMatchObject({ network: "bridge", useProxy: true });
    expect(plan.allowedDomains).toContain("registry.npmjs.org");
    expect(plan.allowedDomains).toContain("*.corp.example");
    expect(plan.allowedDomains).not.toContain("x.test");
  });

  it("open → bridge; the proxy only when deny rules need enforcing", () => {
    expect(deriveSandboxNetwork(policy())).toMatchObject({ network: "bridge", useProxy: false });
    expect(deriveSandboxNetwork(policy({ rules: [{ action: "deny", pattern: "x.test" }] }))).toMatchObject({ network: "bridge", useProxy: true });
  });

  it("an explicit sandbox setting can only tighten the derived one", () => {
    expect(stricterNetwork("host", "bridge")).toBe("bridge");
    expect(stricterNetwork("none", "bridge")).toBe("none");
    expect(stricterNetwork(undefined, "none")).toBe("none");
    expect(stricterNetwork("restricted", "bridge")).toBe("restricted");
    const denyPlan = deriveSandboxNetwork(policy({ mode: "deny" }));
    expect(applySandboxPlan(sandbox("host"), denyPlan).network).toBe("none");
    const openPlan = deriveSandboxNetwork(policy());
    expect(applySandboxPlan(sandbox("none"), openPlan).network).toBe("none");
  });

  it("the docker run command carries the derived network", () => {
    const plan = deriveSandboxNetwork(policy({ mode: "deny" }));
    const derived = applySandboxPlan(sandbox("bridge"), plan);
    const args = buildRunCommand("n", "/tmp/ws", {
      enabled: true,
      image: "img",
      memoryMb: 1,
      cpus: 1,
      pidsLimit: 1,
      startupTimeoutMs: 1,
      extraArgs: [],
      network: derived.network,
      allowedDomains: derived.allowedDomains,
    });
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).not.toContain("host.docker.internal:host-gateway");
  });
});

describe("prepareProcessEgress", () => {
  it("does nothing in open mode without deny rules", async () => {
    const r = await prepareProcessEgress({ repoKey: "r", rootPath: null, policy: policy(), sandbox: sandbox() });
    expect(r).toMatchObject({ ok: true, egressProxy: undefined });
    if (r.ok) expect(r.sandbox?.network).toBe("bridge");
  });

  it("allowlist: proxy URLs for the host and the container", async () => {
    const r = await prepareProcessEgress({ repoKey: "r", rootPath: null, policy: policy({ mode: "allowlist" }), sandbox: sandbox() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.egressProxy?.hostUrl).toMatch(/^http:\/\/viberon:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    expect(r.egressProxy?.containerUrl).toMatch(/^http:\/\/viberon:[0-9a-f]+@host\.docker\.internal:\d+$/);
    expect(r.sandbox?.network).toBe("bridge");
  });

  it("deny: container gets no network; direct execution is still pointed at the proxy", async () => {
    const r = await prepareProcessEgress({ repoKey: "r", rootPath: null, policy: policy({ mode: "deny" }), sandbox: sandbox() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sandbox?.network).toBe("none");
    expect(r.egressProxy?.hostUrl).toBeDefined();
    expect(r.egressProxy?.containerUrl).toBeUndefined();
  });

  it("proxy variables keep localhost direct", () => {
    const env = proxyEnv("http://viberon:t@127.0.0.1:1");
    expect(env.HTTPS_PROXY).toBe("http://viberon:t@127.0.0.1:1");
    expect(env.no_proxy).toContain("localhost");
  });
});

describe("egress proxy", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let proxy: EgressProxy;
  let root: string;
  let currentPolicy = policy();
  const client = () => ({ repoKey: "r", rootPath: root, source: "sandbox" as const });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "egress-proxy-"));
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream saw ${req.method} ${req.url} host=${req.headers.host} auth=${req.headers["proxy-authorization"] ?? "none"}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    proxy = await startEgressProxy({
      policyFor: async () => currentPolicy,
      policyTtlMs: 0,
      lookup: async (host) => (host === "local.test" ? ["127.0.0.1"] : ["93.184.215.14"]),
    });
  });
  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function viaProxy(target: string, auth = true): Promise<{ status: number; body: string }> {
    const token = proxy.tokenFor(client());
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: target,
        headers: auth ? { "proxy-authorization": `Basic ${Buffer.from(`viberon:${token}`).toString("base64")}` } : {},
      });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function connect(target: string): Promise<{ status: string; socket: net.Socket }> {
    const token = proxy.tokenFor(client());
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`viberon:${token}`).toString("base64")}\r\n\r\n`,
        );
      });
      socket.once("data", (chunk) => resolve({ status: chunk.toString("utf8").split("\r\n")[0], socket }));
      socket.on("error", reject);
    });
  }

  it("requires the token", async () => {
    currentPolicy = policy();
    const r = await viaProxy(`http://127.0.0.1:${upstreamPort}/x`, false);
    expect(r.status).toBe(407);
  });

  it("refuses loopback targets unless a rule names them (SSRF)", async () => {
    currentPolicy = policy();
    const r = await viaProxy(`http://127.0.0.1:${upstreamPort}/x`);
    expect(r.status).toBe(403);
    expect(r.body).toContain("loopback");
  });

  it("forwards allowed plain-HTTP requests without leaking the proxy credentials", async () => {
    currentPolicy = policy({ rules: [{ action: "allow", pattern: `127.0.0.1:${upstreamPort}` }] });
    const r = await viaProxy(`http://127.0.0.1:${upstreamPort}/hello?q=1`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(`upstream saw GET /hello?q=1 host=127.0.0.1:${upstreamPort} auth=none`);
  });

  it("tunnels an allowed CONNECT to the checked address", async () => {
    currentPolicy = policy({ rules: [{ action: "allow", pattern: "local.test" }] });
    const { status, socket } = await connect(`local.test:${upstreamPort}`);
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const body = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (c) => (text += c.toString("utf8")));
      socket.on("end", () => resolve(text));
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: local.test\r\nConnection: close\r\n\r\n`);
    });
    expect(body).toContain("upstream saw GET /tunnel host=local.test");
  });

  it("refuses CONNECT to a denied or off-allowlist host", async () => {
    currentPolicy = policy({ mode: "allowlist", presets: [], rules: [{ action: "deny", pattern: "evil.test" }] });
    const denied = await connect("evil.test:443");
    expect(denied.status).toBe("HTTP/1.1 403 Forbidden");
    denied.socket.destroy();
    const off = await connect("elsewhere.test:443");
    expect(off.status).toBe("HTTP/1.1 403 Forbidden");
    off.socket.destroy();
  });

  it("logs every decision with source and rule", async () => {
    const log = await readAudit(root, { limit: 50 });
    expect(log.some((e) => e.host === "evil.test" && e.decision === "deny" && e.source === "sandbox" && e.rule?.includes("[proxy]"))).toBe(true);
    expect(log.some((e) => e.host === "local.test" && e.decision === "allow")).toBe(true);
  });
});
