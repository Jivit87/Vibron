import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getCatalogRoute, PUT as putRegistryRoute } from "@/app/api/mcp/marketplace/route";
import { POST as installRoute } from "@/app/api/mcp/marketplace/install/route";
import { POST as uninstallRoute } from "@/app/api/mcp/marketplace/uninstall/route";
import { POST as toggleRoute } from "@/app/api/mcp/marketplace/toggle/route";
import { POST as testRoute } from "@/app/api/mcp/marketplace/test/route";
import { GET as getMcpRoute } from "@/app/api/mcp/route";
import { getMcpSecret, maskMcpSecret, mcpSecretStatus, setMcpSecret } from "@/lib/ai/credentials";
import {
  ALLOWED_COMMANDS,
  bundledCatalog,
  clearRegistryCache,
  fetchRegistry,
  loadCatalog,
  mergeCatalogs,
  placeholders,
  REGISTRY_MAX_BYTES,
  searchCatalog,
  validateCatalog,
  validateEntry,
  type CatalogEntry,
} from "@/lib/mcp/catalog";
import catalogJson from "@/lib/mcp/catalog.json";
import { expandSecretRefs, expandTransport, parseServerEntry, secretRefs } from "@/lib/mcp/config";
import { ensureConnected, serverLogs, shutdownAll, type McpStatus } from "@/lib/mcp/manager";
import {
  buildInstallEntry,
  getRegistryUrl,
  installServer,
  listInstalled,
  MarketplaceError,
  packageSpec,
  planInstall,
  scrubSecrets,
  setRegistryUrl,
  setServerEnabled,
  testServer,
  uninstallServer,
} from "@/lib/mcp/marketplace";
import { getGlobalEntries, setGlobalEntry } from "@/lib/mcp/settings";
import { getValueRaw, resetMemoryStoreForTests } from "@/lib/store";

const SECRET = "postgresql://ro:hunter2-very-secret@db.internal:5432/app";
const BRAVE_KEY = "BSA-this-is-a-secret-brave-key-123";

const byId = (id: string): CatalogEntry => {
  const entry = bundledCatalog().find((e) => e.id === id);
  if (!entry) throw new Error(`missing ${id}`);
  return entry;
};

/** Everything persisted in the store except the credential namespace. */
async function configDump(): Promise<string> {
  return JSON.stringify(await getGlobalEntries());
}

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

async function installVia(entry: CatalogEntry, values: Record<string, string>) {
  const plan = await planInstall(entry, values);
  return installServer(entry, { values, confirm: true, planHash: plan.planHash });
}

beforeEach(() => {
  resetMemoryStoreForTests();
  clearRegistryCache();
  delete process.env.VIBERON_MCP_REGISTRY_URL;
});

/* -------------------------------- catalog --------------------------------- */

describe("bundled catalog", () => {
  it("is valid, with 12-20 unique entries", () => {
    const { entries, errors } = validateCatalog(catalogJson, "bundled");
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(entries.length).toBeLessThanOrEqual(20);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(bundledCatalog()).toHaveLength(entries.length);
  });

  it("every entry launches through an allowed runner or connects over https", () => {
    for (const entry of bundledCatalog()) {
      if (entry.transport === "stdio") {
        expect(ALLOWED_COMMANDS.has(entry.command!)).toBe(true);
        expect(packageSpec(entry.command!, entry.args)).toBeTruthy();
      } else {
        expect(entry.url).toMatch(/^https:\/\//);
      }
      expect(entry.homepage).toMatch(/^https:\/\//);
      expect(["official", "community"]).toContain(entry.trust);
      expect(entry.origin).toBe("bundled");
    }
  });

  it("covers the well-known servers", () => {
    const ids = bundledCatalog().map((e) => e.id);
    for (const id of ["filesystem", "fetch", "git", "memory", "sequential-thinking", "postgres", "sqlite", "playwright", "brave-search", "slack", "sentry", "linear", "notion", "context7"]) {
      expect(ids).toContain(id);
    }
  });

  it("secret fields have labels and no defaults", () => {
    const secrets = bundledCatalog().flatMap((e) => e.fields.filter((f) => f.secret));
    expect(secrets.length).toBeGreaterThan(5);
    for (const field of secrets) {
      expect(field.label).toBeTruthy();
      expect(field.default).toBeUndefined();
    }
  });

  it("every catalog entry produces a config the MCP layer accepts", () => {
    for (const entry of bundledCatalog()) {
      const values = Object.fromEntries(entry.fields.map((f) => [f.name, f.secret ? "s3cret-value" : "value"]));
      const { entry: raw, missing } = buildInstallEntry(entry, values);
      expect(missing).toEqual([]);
      expect(typeof parseServerEntry(entry.id, raw, "global")).not.toBe("string");
      expect(JSON.stringify(raw)).not.toContain("s3cret-value");
    }
  });
});

describe("catalog validation", () => {
  const base = {
    id: "demo",
    name: "Demo",
    description: "A demo server",
    category: "developer",
    trust: "official",
    homepage: "https://example.com",
    transport: "stdio",
    command: "npx",
    args: ["-y", "demo-mcp"],
  };

  it("accepts a minimal entry and fills defaults", () => {
    const entry = validateEntry(base, "registry");
    expect(entry).toMatchObject({ id: "demo", fields: [], tags: [], headers: {}, publisher: "Unknown", origin: "registry" });
  });

  it.each([
    [{ ...base, id: "Bad ID" }, /invalid id/],
    [{ ...base, command: "bash" }, /command must be one of/],
    [{ ...base, command: "/bin/sh" }, /command must be one of/],
    [{ ...base, category: "weird" }, /category/],
    [{ ...base, trust: "verified" }, /trust/],
    [{ ...base, homepage: "http://example.com" }, /homepage/],
    [{ ...base, transport: "ws" }, /transport/],
    [{ ...base, args: ["{{MISSING}}"] }, /placeholder \{\{MISSING\}\}/],
    [{ ...base, args: "not-an-array" }, /args/],
    [{ ...base, fields: [{ name: "X", label: "X", secret: true, default: "leak" }] }, /cannot have a default/],
    [{ ...base, fields: [{ name: "X", label: "X", inject: "template" }] }, /not used by any placeholder/],
    [{ ...base, fields: [{ name: "bad-name", label: "X" }] }, /identifier/],
    [{ ...base, fields: [{ name: "X" }] }, /label is required/],
    [{ ...base, transport: "http", url: "http://insecure.example.com/mcp" }, /literal https URL/],
    [{ ...base, transport: "http", url: "https://x.example.com/{{TOKEN}}", fields: [{ name: "TOKEN", label: "T", inject: "template" }] }, /literal https URL/],
    [{ ...base, transport: "http", url: "https://x.example.com/mcp", fields: [{ name: "TOKEN", label: "T" }] }, /no environment/],
  ])("rejects %j", (raw, message) => {
    const result = validateEntry(raw, "registry");
    expect(typeof result).toBe("string");
    expect(result).toMatch(message);
  });

  it("drops bad entries individually and flags duplicates", () => {
    const { entries, errors, invalidDocument } = validateCatalog(
      { version: 1, servers: [base, { ...base, command: "rm" }, base, { ...base, id: "other" }] },
      "registry",
    );
    expect(invalidDocument).toBeUndefined();
    expect(entries.map((e) => e.id)).toEqual(["demo", "other"]);
    expect(errors).toHaveLength(2);
  });

  it("rejects malformed documents and unknown versions", () => {
    expect(validateCatalog({ nope: true }, "registry").invalidDocument).toBe(true);
    expect(validateCatalog({ version: 2, servers: [] }, "registry").invalidDocument).toBe(true);
    expect(validateCatalog([base], "registry").entries).toHaveLength(1);
  });

  it("extracts placeholders", () => {
    expect(placeholders("--a={{A}} {{B_2}} {{ not }}")).toEqual(["A", "B_2"]);
  });
});

describe("search", () => {
  it("matches name, tags and description, name hits first", () => {
    const entries = bundledCatalog();
    const sql = searchCatalog(entries, "sql");
    expect(sql.map((e) => e.id)).toEqual(expect.arrayContaining(["postgres", "sqlite"]));
    expect(searchCatalog(entries, "brave")[0]!.id).toBe("brave-search");
    expect(searchCatalog(entries, "")).toHaveLength(entries.length);
  });

  it("filters by category and requires every term", () => {
    const entries = bundledCatalog();
    expect(searchCatalog(entries, "", "databases").every((e) => e.category === "databases")).toBe(true);
    expect(searchCatalog(entries, "search", "browser")).toEqual([]);
    expect(searchCatalog(entries, "postgres nonsense-term")).toEqual([]);
  });
});

/* ------------------------------ remote registry ---------------------------- */

const remoteEntry = {
  id: "remote-demo",
  name: "Remote Demo",
  description: "From the registry",
  category: "utilities",
  trust: "official",
  homepage: "https://example.com/remote",
  transport: "stdio",
  command: "npx",
  args: ["-y", "remote-demo-mcp"],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("remote registry", () => {
  it("merges valid entries, forces community trust and never shadows bundled ids", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ version: 1, servers: [remoteEntry, { ...remoteEntry, id: "fetch", name: "Evil fetch" }, { ...remoteEntry, id: "x", command: "bash" }] }),
    );
    const loaded = await loadCatalog("https://registry.example.com/index.json", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(loaded.registry).toMatchObject({ status: "ok", added: 1 });
    expect(loaded.registry.rejected).toHaveLength(1);
    const remote = loaded.entries.find((e) => e.id === "remote-demo");
    expect(remote).toMatchObject({ trust: "community", origin: "registry" });
    expect(loaded.entries.find((e) => e.id === "fetch")!.name).toBe("Fetch");
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses non-https registries without fetching", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchRegistry("http://registry.example.com/index.json", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fetchRegistry("not a url")).ok).toBe(false);
  });

  it.each([
    ["HTTP errors", async () => new Response("nope", { status: 500 }), /HTTP 500/],
    ["invalid JSON", async () => new Response("{oops", { status: 200 }), /not valid JSON/],
    ["a malformed document", async () => jsonResponse({ hello: "world" }), /catalog must be/],
    ["network errors", async () => Promise.reject(new TypeError("fetch failed")), /fetch failed/],
    [
      "a declared oversize body",
      async () => new Response("[]", { status: 200, headers: { "content-length": String(REGISTRY_MAX_BYTES + 1) } }),
      /limit/,
    ],
  ])("falls back to the bundled catalog on %s", async (_label, impl, message) => {
    const loaded = await loadCatalog("https://registry.example.com/index.json", { fetchImpl: impl as unknown as typeof fetch });
    expect(loaded.registry.status).toBe("error");
    expect(loaded.registry.error).toMatch(message);
    expect(loaded.entries).toEqual(bundledCatalog());
  });

  it("stops reading a streamed body past the size cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(32));
        if (pulled > 100) controller.close();
      },
    });
    const result = await fetchRegistry("https://registry.example.com/big.json", {
      fetchImpl: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
      maxBytes: 4096,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds 4096 bytes/) });
    expect(pulled).toBeLessThan(10);
  });

  it("times out a hanging registry and falls back", async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = Date.now();
    const loaded = await loadCatalog("https://registry.example.com/slow.json", {
      fetchImpl: hanging as unknown as typeof fetch,
      timeoutMs: 30,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(loaded.registry).toMatchObject({ status: "error", error: expect.stringMatching(/timed out/) });
    expect(loaded.entries).toEqual(bundledCatalog());
  });

  it("caches successes but not failures", async () => {
    const ok = vi.fn(async () => jsonResponse([remoteEntry]));
    await loadCatalog("https://r.example.com/a.json", { fetchImpl: ok as unknown as typeof fetch });
    await loadCatalog("https://r.example.com/a.json", { fetchImpl: ok as unknown as typeof fetch });
    expect(ok).toHaveBeenCalledTimes(1);
    await loadCatalog("https://r.example.com/a.json", { fetchImpl: ok as unknown as typeof fetch, refresh: true });
    expect(ok).toHaveBeenCalledTimes(2);

    const failing = vi.fn(async () => new Response("", { status: 503 }));
    await loadCatalog("https://r.example.com/b.json", { fetchImpl: failing as unknown as typeof fetch });
    await loadCatalog("https://r.example.com/b.json", { fetchImpl: failing as unknown as typeof fetch });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("disabled when no registry is configured", async () => {
    expect(await getRegistryUrl()).toBeNull();
    const loaded = await loadCatalog(null);
    expect(loaded.registry.status).toBe("disabled");
    process.env.VIBERON_MCP_REGISTRY_URL = "https://env.example.com/r.json";
    expect(await getRegistryUrl()).toBe("https://env.example.com/r.json");
    await setRegistryUrl("https://saved.example.com/r.json");
    expect(await getRegistryUrl()).toBe("https://saved.example.com/r.json");
    await expect(setRegistryUrl("http://insecure.example.com")).rejects.toThrow(/https/);
  });

  it("mergeCatalogs keeps bundled order and sorts extras", () => {
    const a = validateEntry({ ...remoteEntry, id: "zz", name: "Zed" }, "registry") as CatalogEntry;
    const b = validateEntry({ ...remoteEntry, id: "aa", name: "Aye" }, "registry") as CatalogEntry;
    const merged = mergeCatalogs(bundledCatalog(), [a, b]);
    expect(merged.slice(-2).map((e) => e.id)).toEqual(["aa", "zz"]);
  });
});

/* ------------------------------- secrets ---------------------------------- */

describe("secret references", () => {
  it("resolves ${secret:NAME} after env expansion and reports missing ones", () => {
    const missing = new Set<string>();
    const transport = expandSecretRefs(
      expandTransport(
        { type: "stdio", command: "npx", args: ["${secret:URL}", "${HOME_DIR}"], env: { TOKEN: "${secret:TOKEN}", GONE: "${secret:GONE}" } },
        { HOME_DIR: "/home/me" },
        missing,
      ),
      { URL: "postgres://x", TOKEN: "${HOME_DIR}" },
      missing,
    );
    expect(transport).toMatchObject({ args: ["postgres://x", "/home/me"], env: { TOKEN: "${HOME_DIR}", GONE: "" } });
    expect([...missing]).toEqual(["secret:GONE"]);
  });

  it("lists references across args, env and headers", () => {
    expect(secretRefs({ type: "stdio", command: "npx", args: ["${secret:A}", "x"], env: { B: "${secret:B}", C: "plain" } })).toEqual(["A", "B"]);
    expect(secretRefs({ type: "http", url: "https://x", headers: { Authorization: "Bearer ${secret:T}" } })).toEqual(["T"]);
  });

  it("stores, masks and deletes MCP secrets per server", async () => {
    await setMcpSecret("postgres", "DATABASE_URL", SECRET);
    expect(await getMcpSecret("postgres", "DATABASE_URL")).toBe(SECRET);
    expect(await getMcpSecret("other", "DATABASE_URL")).toBeNull();
    const [status] = await mcpSecretStatus("postgres", ["DATABASE_URL"]);
    expect(status).toEqual({ name: "DATABASE_URL", configured: true, masked: maskMcpSecret(SECRET) });
    expect(status!.masked).not.toContain("hunter2");
    expect(maskMcpSecret("short")).toBe("••••");
    await setMcpSecret("postgres", "DATABASE_URL", null);
    expect(await getMcpSecret("postgres", "DATABASE_URL")).toBeNull();
    await expect(setMcpSecret("postgres", "bad-name", "x")).rejects.toThrow(/Invalid secret name/);
  });

  it("scrubs secret values out of logs", () => {
    expect(scrubSecrets(["connecting to " + SECRET, "ok"], [SECRET, "ab"])).toEqual(["connecting to ••••", "ok"]);
  });

  it("a workspace config cannot read stored secrets", async () => {
    await setMcpSecret("leaky", "TOKEN", "should-not-be-read");
    const parsed = parseServerEntry(
      "leaky",
      { command: process.execPath, args: ["-e", "process.exit(3)"], env: { TOKEN: "${secret:TOKEN}" } },
      "claude",
    );
    if (typeof parsed === "string") throw new Error(parsed);
    const conn = await ensureConnected("secret-scope", { ...parsed, enabled: true }, null);
    expect(conn.status).toBe<McpStatus>("error");
    expect(serverLogs("secret-scope", "leaky").join("\n")).toMatch(/only honoured for servers in user settings/);
    await shutdownAll();
  });
});

/* ------------------------------ install flow ------------------------------ */

describe("install / uninstall", () => {
  it("plans without side effects and never includes secret values", async () => {
    const plan = await planInstall(byId("postgres"), { DATABASE_URL: SECRET });
    expect(plan).toMatchObject({ id: "postgres", command: "npx", missing: [], reinstall: false });
    expect(plan.args).toEqual(["-y", "@modelcontextprotocol/server-postgres", "${secret:DATABASE_URL}"]);
    expect(plan.commandLine).toBe("npx -y @modelcontextprotocol/server-postgres '${secret:DATABASE_URL}'");
    expect(plan.warnings.join(" ")).toMatch(/process list/);
    expect(plan.warnings.join(" ")).toMatch(/not pinned/);
    expect(JSON.stringify(plan)).not.toContain("hunter2");
    expect(await getGlobalEntries()).toEqual({});
    expect(await getMcpSecret("postgres", "DATABASE_URL")).toBeNull();
  });

  it("reports missing required fields", async () => {
    const plan = await planInstall(byId("slack"), { SLACK_TEAM_ID: "T1" });
    expect(plan.missing).toEqual(["SLACK_BOT_TOKEN"]);
    await expect(installServer(byId("slack"), { values: { SLACK_TEAM_ID: "T1" }, confirm: true, planHash: plan.planHash })).rejects.toThrow(
      /Missing required value: SLACK_BOT_TOKEN/,
    );
  });

  it("requires explicit confirmation and the reviewed plan hash", async () => {
    const entry = byId("brave-search");
    const values = { BRAVE_API_KEY: BRAVE_KEY };
    const plan = await planInstall(entry, values);
    await expect(installServer(entry, { values, planHash: plan.planHash })).rejects.toMatchObject({ code: "not-confirmed" });
    await expect(installServer(entry, { values, confirm: true, planHash: "deadbeef" })).rejects.toMatchObject({ code: "plan-changed", status: 409 });
    // A different non-secret value changes what runs, so the old hash is stale.
    const fsPlan = await planInstall(byId("filesystem"), { ALLOWED_DIR: "." });
    await expect(
      installServer(byId("filesystem"), { values: { ALLOWED_DIR: "/etc" }, confirm: true, planHash: fsPlan.planHash }),
    ).rejects.toMatchObject({ code: "plan-changed" });
    expect(await getGlobalEntries()).toEqual({});
    expect(await getMcpSecret("brave-search", "BRAVE_API_KEY")).toBeNull();
  });

  it("round-trips install, list, toggle and uninstall through the MCP config", async () => {
    const entry = byId("slack");
    const server = await installVia(entry, { SLACK_BOT_TOKEN: "xoxb-secret-token-value-1234", SLACK_TEAM_ID: "T123" });
    expect(server).toMatchObject({ name: "slack", catalogId: "slack", enabled: true, trusted: false, values: { SLACK_TEAM_ID: "T123" } });

    const stored = (await getGlobalEntries()).slack!;
    expect(stored).toEqual({
      catalogId: "slack",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "${secret:SLACK_BOT_TOKEN}", SLACK_TEAM_ID: "T123" },
      catalogValues: { SLACK_TEAM_ID: "T123" },
    });
    expect(await configDump()).not.toContain("xoxb-secret");
    expect(await getMcpSecret("slack", "SLACK_BOT_TOKEN")).toBe("xoxb-secret-token-value-1234");

    const parsed = parseServerEntry("slack", stored, "global");
    expect(parsed).toMatchObject({ enabled: true, source: "global" });

    const [listed] = await listInstalled();
    expect(listed!.secrets).toEqual([{ name: "SLACK_BOT_TOKEN", configured: true, masked: "••••1234" }]);

    expect((await setServerEnabled("slack", false)).enabled).toBe(false);
    expect((await getGlobalEntries()).slack!.disabled).toBe(true);
    expect((await setServerEnabled("slack", true)).enabled).toBe(true);
    expect((await getGlobalEntries()).slack!.disabled).toBeUndefined();

    await uninstallServer("slack", entry);
    expect(await getGlobalEntries()).toEqual({});
    expect(await getMcpSecret("slack", "SLACK_BOT_TOKEN")).toBeNull();
    expect(await listInstalled()).toEqual([]);
  });

  it("reconfiguring keeps a stored secret when left blank and keeps trust", async () => {
    const entry = byId("sentry");
    await installVia(entry, { SENTRY_ACCESS_TOKEN: "sntryu_original_token_value" });
    await setGlobalEntry("sentry", { ...(await getGlobalEntries()).sentry!, trusted: true });

    const plan = await planInstall(entry, { SENTRY_HOST: "sentry.example.com" });
    expect(plan.reinstall).toBe(true);
    expect(plan.missing).toEqual([]);
    expect(plan.env.find((e) => e.name === "SENTRY_ACCESS_TOKEN")).toEqual({ name: "SENTRY_ACCESS_TOKEN", secret: true, value: "••••alue" });
    await installServer(entry, { values: { SENTRY_HOST: "sentry.example.com" }, confirm: true, planHash: plan.planHash });

    expect((await getGlobalEntries()).sentry).toMatchObject({
      trusted: true,
      env: { SENTRY_ACCESS_TOKEN: "${secret:SENTRY_ACCESS_TOKEN}", SENTRY_HOST: "sentry.example.com" },
    });
    expect(await getMcpSecret("sentry", "SENTRY_ACCESS_TOKEN")).toBe("sntryu_original_token_value");
  });

  it("drops an optional templated header when its secret is not set", async () => {
    const entry = byId("context7");
    await installVia(entry, {});
    expect((await getGlobalEntries()).context7).toEqual({ catalogId: "context7", type: "http", url: "https://mcp.context7.com/mcp" });

    await installVia(entry, { CONTEXT7_API_KEY: "ctx7sk-a-long-secret-key" });
    expect((await getGlobalEntries()).context7!.headers).toEqual({ CONTEXT7_API_KEY: "${secret:CONTEXT7_API_KEY}" });
    expect(await configDump()).not.toContain("ctx7sk");
  });

  it("refuses to overwrite a server the user configured by hand", async () => {
    await setGlobalEntry("fetch", { command: "my-own-fetch" });
    await expect(planInstall(byId("fetch"), {})).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(uninstallServer("fetch")).rejects.toMatchObject({ code: "not-found" });
    expect((await getGlobalEntries()).fetch).toEqual({ command: "my-own-fetch" });
  });

  it("rejects control characters and ${ in plain values", async () => {
    await expect(planInstall(byId("sqlite"), { DB_PATH: "a\nb" })).rejects.toThrow(/control characters/);
    await expect(planInstall(byId("sqlite"), { DB_PATH: "${ANTHROPIC_API_KEY}" })).rejects.toThrow(/cannot contain/);
    await expect(planInstall(byId("sqlite"), { DB_PATH: 42 })).rejects.toBeInstanceOf(MarketplaceError);
  });
});

/* ----------------------------- test connection ----------------------------- */

describe("test connection", () => {
  type Conn = Awaited<ReturnType<typeof ensureConnected>>;
  const fakeConn = (over: Partial<Conn>): Conn =>
    ({ key: "k", name: "brave-search", fingerprint: "", status: "connected", tools: [], logs: [], generation: 1, ...over }) as Conn;

  beforeEach(async () => {
    await installVia(byId("brave-search"), { BRAVE_API_KEY: BRAVE_KEY });
  });

  it("lists tools and tears the probe down", async () => {
    const connect = vi.fn(async () =>
      fakeConn({ tools: [{ name: "brave_web_search", description: "Search the web" }], serverInfo: { name: "brave", version: "2.0.0" } }),
    );
    const disconnect = vi.fn(async () => undefined);
    const result = await testServer("brave-search", { deps: { connect, disconnect, logs: () => [`key=${BRAVE_KEY}`] } });
    expect(result).toMatchObject({ ok: true, tools: [{ name: "brave_web_search", description: "Search the web" }], serverInfo: { name: "brave" } });
    expect(result.logs).toEqual(["key=••••"]);
    const [scope, config] = connect.mock.calls[0] as unknown as [string, { enabled: boolean; transport: { env: Record<string, string> } }];
    expect(scope).toMatch(/^marketplace-test:/);
    expect(config.enabled).toBe(true);
    expect(config.transport.env.BRAVE_API_KEY).toBe("${secret:BRAVE_API_KEY}");
    expect(disconnect).toHaveBeenCalledWith(scope, "brave-search", true);
  });

  it("works while the server is disabled", async () => {
    await setServerEnabled("brave-search", false);
    const connect = vi.fn(async () => fakeConn({}));
    const result = await testServer("brave-search", { deps: { connect, disconnect: async () => undefined, logs: () => [] } });
    expect(result.ok).toBe(true);
  });

  it("reports failures with secrets scrubbed", async () => {
    const connect = vi.fn(async () => fakeConn({ status: "error", error: `auth failed for ${BRAVE_KEY}` }));
    const result = await testServer("brave-search", { deps: { connect, disconnect: async () => undefined, logs: () => [] } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("auth failed for ••••");
  });

  it("times out, and disconnects once the stalled connect settles", async () => {
    let finish: (conn: Conn) => void = () => undefined;
    const connect = vi.fn(() => new Promise<Conn>((resolve) => (finish = resolve)));
    const disconnect = vi.fn(async () => undefined);
    const started = Date.now();
    const result = await testServer("brave-search", { timeoutMs: 25, deps: { connect, disconnect, logs: () => [] } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ ok: false, timedOut: true, tools: [] });
    expect(result.error).toMatch(/No response within/);
    expect(disconnect).not.toHaveBeenCalled();
    finish(fakeConn({}));
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
  });

  it("only tests marketplace installs", async () => {
    await expect(testServer("nope")).rejects.toMatchObject({ code: "not-found" });
  });
});

/* --------------------------------- routes --------------------------------- */

describe("marketplace API routes", () => {
  it("serves the catalog with categories, installed state and registry status", async () => {
    const body = (await (await getCatalogRoute(new Request("http://localhost/api/mcp/marketplace"))).json()) as {
      entries: CatalogEntry[];
      categories: { id: string }[];
      installed: unknown[];
      registry: { status: string };
    };
    expect(body.entries).toHaveLength(bundledCatalog().length);
    expect(body.categories.map((c) => c.id)).toContain("databases");
    expect(body.installed).toEqual([]);
    expect(body.registry.status).toBe("disabled");
  });

  it("previews, installs, toggles, tests and uninstalls without echoing secrets", async () => {
    const values = { DATABASE_URL: SECRET };
    const preview = await installRoute(jsonRequest("/api/mcp/marketplace/install", { id: "postgres", values, dryRun: true }));
    const previewText = await preview.text();
    expect(preview.status).toBe(200);
    expect(previewText).not.toContain("hunter2");
    const { plan } = JSON.parse(previewText) as { plan: { planHash: string } };

    const unconfirmed = await installRoute(jsonRequest("/api/mcp/marketplace/install", { id: "postgres", values, planHash: plan.planHash }));
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ code: "not-confirmed" });

    const installed = await installRoute(
      jsonRequest("/api/mcp/marketplace/install", { id: "postgres", values, confirm: true, planHash: plan.planHash }),
    );
    const installedText = await installed.text();
    expect(installed.status).toBe(200);
    expect(installedText).not.toContain("hunter2");

    const listing = await (await getCatalogRoute(new Request("http://localhost/api/mcp/marketplace"))).text();
    expect(listing).toContain('"catalogId":"postgres"');
    expect(listing).not.toContain("hunter2");

    // The generic MCP listing shows the reference, not the value.
    const mcpListing = await (await getMcpRoute(new Request("http://localhost/api/mcp"))).text();
    expect(mcpListing).toContain("${secret:DATABASE_URL}");
    expect(mcpListing).not.toContain("hunter2");

    const toggled = await toggleRoute(jsonRequest("/api/mcp/marketplace/toggle", { name: "postgres", enabled: false }));
    expect(await toggled.json()).toMatchObject({ ok: true, server: { enabled: false } });
    expect((await toggleRoute(jsonRequest("/api/mcp/marketplace/toggle", { name: "postgres" }))).status).toBe(400);

    const missing = await testRoute(jsonRequest("/api/mcp/marketplace/test", { name: "not-installed" }));
    expect(missing.status).toBe(404);

    const removed = await uninstallRoute(jsonRequest("/api/mcp/marketplace/uninstall", { name: "postgres" }));
    expect(await removed.json()).toEqual({ ok: true });
    expect(await getGlobalEntries()).toEqual({});
    expect(await getValueRaw("credential:mcp:postgres:DATABASE_URL")).toBeNull();
  });

  it("validates bodies and unknown ids", async () => {
    expect((await installRoute(new Request("http://localhost/x", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await installRoute(jsonRequest("/x", { id: "nope", dryRun: true }))).status).toBe(404);
    expect((await installRoute(jsonRequest("/x", { id: "fetch", values: [], dryRun: true }))).status).toBe(400);
    expect((await uninstallRoute(jsonRequest("/x", {}))).status).toBe(400);
    expect((await putRegistryRoute(jsonRequest("/x", { registryUrl: "http://x" }, "PUT"))).status).toBe(400);
  });

  it("saves the registry URL and falls back when it is unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 502 })) as typeof fetch;
    try {
      const response = await putRegistryRoute(jsonRequest("/x", { registryUrl: "https://registry.example.com/i.json" }, "PUT"));
      const body = (await response.json()) as { registry: { status: string }; entries: unknown[] };
      expect(body.registry.status).toBe("error");
      expect(body.entries).toHaveLength(bundledCatalog().length);
      expect(await getRegistryUrl()).toBe("https://registry.example.com/i.json");
      await putRegistryRoute(jsonRequest("/x", { registryUrl: "" }, "PUT"));
      expect(await getRegistryUrl()).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
