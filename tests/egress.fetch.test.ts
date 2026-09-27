import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browseUrl, searchWeb } from "@/lib/browse";
import { readAudit } from "@/lib/egress/audit";
import { checkUrl, egressFetch, type Lookup } from "@/lib/egress/fetch";
import { DEFAULT_EGRESS_POLICY, resolvePolicy, type EgressPolicy } from "@/lib/egress/policy";

const DNS: Record<string, string[]> = {
  "docs.example.com": ["93.184.215.14"],
  "cdn.example.com": ["93.184.215.15"],
  "evil.test": ["198.51.100.99"],
  "rebind.test": ["93.184.215.20", "10.0.0.7"],
  "metadata.attacker.test": ["169.254.169.254"],
  "intranet.corp.example": ["10.1.2.3"],
};
const lookup: Lookup = async (host) => {
  const hit = DNS[host];
  if (!hit) throw new Error(`ENOTFOUND ${host}`);
  return hit;
};

const policy = (patch: Partial<EgressPolicy> = {}) => resolvePolicy({ ...DEFAULT_EGRESS_POLICY, ...patch }, null);

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}
function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "egress-fetch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkUrl", () => {
  it("allows a public host and logs the decision", async () => {
    const r = await checkUrl("https://docs.example.com/a?token=secret#x", { policy: policy(), source: "browse", lookup, rootPath: root });
    expect(r).toMatchObject({ allowed: true, host: "docs.example.com", port: 443, address: "93.184.215.14" });
    const log = await readFile(path.join(root, ".viberon", "egress.log"), "utf8");
    const entry = JSON.parse(log.trim());
    expect(entry).toMatchObject({ host: "docs.example.com", decision: "allow", source: "browse", rule: "mode:open" });
    // Query strings (where tokens live) are never logged.
    expect(entry.url).toBe("https://docs.example.com/a");
    expect(typeof entry.ts).toBe("string");
  });

  it("blocks non-http schemes", async () => {
    expect(await checkUrl("file:///etc/passwd", { policy: policy(), source: "browse", lookup, audit: false })).toMatchObject({ allowed: false, rule: "scheme" });
    expect(await checkUrl("ftp://docs.example.com/", { policy: policy(), source: "browse", lookup, audit: false })).toMatchObject({ allowed: false, rule: "scheme" });
  });

  it("SSRF: blocks metadata, loopback and private targets even in open mode", async () => {
    const scope = { policy: policy(), source: "browse" as const, lookup, audit: false };
    expect(await checkUrl("http://169.254.169.254/latest/meta-data/", scope)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(await checkUrl("http://[::ffff:169.254.169.254]/", scope)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(await checkUrl("http://2852039166/", scope)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(await checkUrl("http://metadata.google.internal/computeMetadata/v1/", scope)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(await checkUrl("http://metadata.attacker.test/", scope)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(await checkUrl("http://127.0.0.1:3000/", scope)).toMatchObject({ allowed: false, rule: "ssrf:loopback" });
    expect(await checkUrl("http://[::1]/", scope)).toMatchObject({ allowed: false, rule: "ssrf:loopback" });
    expect(await checkUrl("http://192.168.1.1/", scope)).toMatchObject({ allowed: false, rule: "ssrf:private" });
    expect(await checkUrl("http://intranet.corp.example/", scope)).toMatchObject({ allowed: false, rule: "ssrf:private" });
  });

  it("SSRF: a name with any private address is treated as private", async () => {
    const r = await checkUrl("https://rebind.test/", { policy: policy(), source: "browse", lookup, audit: false });
    expect(r).toMatchObject({ allowed: false, rule: "ssrf:private", address: "10.0.0.7" });
  });

  it("SSRF: explicit rules open private targets", async () => {
    const p = policy({ rules: [{ action: "allow", pattern: "intranet.corp.example" }, { action: "allow", pattern: "127.0.0.1:3000" }] });
    const scope = { policy: p, source: "browse" as const, lookup, audit: false };
    expect((await checkUrl("http://intranet.corp.example/", scope)).allowed).toBe(true);
    expect((await checkUrl("http://127.0.0.1:3000/", scope)).allowed).toBe(true);
    expect((await checkUrl("http://127.0.0.1:4000/", scope)).allowed).toBe(false);
  });

  it("fails closed when DNS fails", async () => {
    expect(await checkUrl("https://unknown.test/", { policy: policy(), source: "browse", lookup, audit: false })).toMatchObject({ allowed: false, rule: "dns" });
  });
});

describe("egressFetch redirects", () => {
  it("re-checks every hop and blocks a redirect to a denied host", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://docs.example.com/start") return redirect(302, "https://evil.test/steal");
      return page("should not be fetched");
    });
    const result = await egressFetch("https://docs.example.com/start", {}, {
      policy: policy({ rules: [{ action: "deny", pattern: "evil.test" }] }),
      source: "browse",
      lookup,
      rootPath: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked).toMatchObject({ host: "evil.test", rule: "deny evil.test (global)" });
    expect(result.hops).toEqual(["https://docs.example.com/start", "https://evil.test/steal"]);
    // The denied hop was never requested.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
    const log = await readAudit(root);
    expect(log.map((e) => `${e.decision}:${e.host}`)).toEqual(["deny:evil.test", "allow:docs.example.com"]);
  });

  it("blocks a redirect into the metadata service (SSRF via redirect)", async () => {
    const fetchImpl = vi.fn(async () => redirect(301, "http://169.254.169.254/latest/meta-data/iam/"));
    const result = await egressFetch("https://docs.example.com/", {}, {
      policy: policy(),
      source: "browse",
      lookup,
      audit: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.rule).toBe("ssrf:metadata");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("in allowlist mode, a redirect off the allowlist is blocked", async () => {
    const fetchImpl = vi.fn(async () => redirect(307, "https://cdn.example.com/file"));
    const result = await egressFetch("https://docs.example.com/", {}, {
      policy: policy({ mode: "allowlist", presets: [], rules: [{ action: "allow", pattern: "docs.example.com" }] }),
      source: "browse",
      lookup,
      audit: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toMatchObject({ host: "cdn.example.com", rule: "mode:allowlist" });
  });

  it("follows allowed relative redirects and turns POST into GET on 303", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      if (calls.length === 1) return redirect(303, "/done");
      if (calls.length === 2) return redirect(308, "https://cdn.example.com/final");
      return page("<title>ok</title>");
    });
    const result = await egressFetch("https://docs.example.com/form", { method: "POST", body: "a=1" }, {
      policy: policy(),
      source: "browse",
      lookup,
      audit: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.finalUrl).toBe("https://cdn.example.com/final");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://docs.example.com/form",
      "GET https://docs.example.com/done",
      "GET https://cdn.example.com/final",
    ]);
    expect(calls[1].body).toBeUndefined();
  });

  it("stops after too many redirects", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => redirect(302, `https://docs.example.com/${++n}`));
    const result = await egressFetch("https://docs.example.com/0", {}, {
      policy: policy(),
      source: "browse",
      lookup,
      audit: false,
      maxRedirects: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.rule).toBe("redirect-limit");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("browse tool integration", () => {
  it("browseUrl refuses a redirect to a disallowed host with a clear error", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("docs.example.com") ? redirect(302, "http://10.0.0.1/admin") : page("x"),
    );
    const result = await browseUrl("https://docs.example.com/", {
      egress: { policy: policy(), lookup, fetchImpl: fetchImpl as unknown as typeof fetch, rootPath: root },
    });
    expect(result.blocked).toBe(true);
    expect(result.error).toMatch(/Blocked by the network egress policy: .*private address 10\.0\.0\.1/);
    expect(result.error).toContain("https://docs.example.com/ → http://10.0.0.1/admin");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("browseUrl reports the final URL after allowed redirects", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/old") ? redirect(301, "https://docs.example.com/new") : page("<title>New</title><main><p>Hello</p></main>"),
    );
    const result = await browseUrl("https://docs.example.com/old", {
      egress: { policy: policy(), lookup, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(result.error).toBeUndefined();
    expect(result.url).toBe("https://docs.example.com/new");
    expect(result.title).toBe("New");
    expect(result.hops).toHaveLength(2);
  });

  it("browseUrl refuses a host outside the allowlist without fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await browseUrl("https://evil.test/", {
      egress: {
        policy: policy({ mode: "allowlist", presets: ["docs"] }),
        lookup,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });
    expect(result.blocked).toBe(true);
    expect(result.error).toContain("not on the egress allowlist");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("searchWeb goes through the policy too", async () => {
    const fetchImpl = vi.fn();
    const out = await searchWeb("anything", {
      egress: { policy: policy({ mode: "deny" }), lookup, fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(out).toMatch(/^Search blocked by the network egress policy/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("audit log", () => {
  it("is append-only JSONL, newest first on read, with filters", async () => {
    const scope = { policy: policy({ rules: [{ action: "deny", pattern: "evil.test" }] }), source: "browse" as const, lookup, rootPath: root };
    await checkUrl("https://docs.example.com/1", scope);
    await checkUrl("https://evil.test/2", scope);
    await checkUrl("https://docs.example.com/3", scope);
    const raw = await readFile(path.join(root, ".viberon", "egress.log"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(3);
    const all = await readAudit(root);
    expect(all.map((e) => e.url)).toEqual(["https://docs.example.com/3", "https://evil.test/2", "https://docs.example.com/1"]);
    expect((await readAudit(root, { decision: "deny" })).map((e) => e.host)).toEqual(["evil.test"]);
    expect(await readAudit(root, { limit: 1 })).toHaveLength(1);
    expect(await readAudit(path.join(root, "missing"))).toEqual([]);
  });
});
