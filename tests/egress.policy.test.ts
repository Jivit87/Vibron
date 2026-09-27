import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EGRESS_POLICY,
  checkAddress,
  evaluateHost,
  resolvePolicy,
  sanitizePolicy,
  sanitizeWorkspacePolicy,
  withApprovedHosts,
  type EgressPolicy,
  type WorkspaceEgressPolicy,
} from "@/lib/egress/policy";
import {
  getGlobalPolicy,
  loadEffectivePolicy,
  setGlobalPolicy,
  setWorkspacePolicy,
} from "@/lib/egress/settings";
import { resetMemoryStoreForTests } from "@/lib/store";

const global = (patch: Partial<EgressPolicy> = {}): EgressPolicy => ({ ...DEFAULT_EGRESS_POLICY, ...patch });

describe("evaluateHost: modes", () => {
  it("open allows everything that is not denied", () => {
    const p = resolvePolicy(global({ rules: [{ action: "deny", pattern: "*.evil.test" }] }), null);
    expect(evaluateHost(p, "example.com", 443, "browse")).toMatchObject({ allowed: true, rule: "mode:open", explicit: false });
    expect(evaluateHost(p, "x.evil.test", 443, "browse")).toMatchObject({ allowed: false, rule: "deny *.evil.test (global)" });
  });

  it("allowlist allows presets and allow rules only", () => {
    const p = resolvePolicy(
      global({ mode: "allowlist", presets: ["packageRegistries"], rules: [{ action: "allow", pattern: "*.corp.example" }] }),
      null,
    );
    expect(evaluateHost(p, "registry.npmjs.org", 443, "terminal")).toMatchObject({ allowed: true, rule: expect.stringContaining("preset:packageRegistries") });
    expect(evaluateHost(p, "git.corp.example", 443, "terminal")).toMatchObject({ allowed: true, explicit: true, matchedKind: "wildcard" });
    expect(evaluateHost(p, "developer.mozilla.org", 443, "browse")).toMatchObject({ allowed: false, rule: "mode:allowlist" });
  });

  it("presets do nothing outside allowlist mode", () => {
    const deny = resolvePolicy(global({ mode: "deny", presets: ["packageRegistries"] }), null);
    expect(evaluateHost(deny, "registry.npmjs.org", 443, "terminal").allowed).toBe(false);
  });

  it("deny mode ignores allow rules (a kill switch)", () => {
    const p = resolvePolicy(global({ mode: "deny", rules: [{ action: "allow", pattern: "example.com" }] }), null);
    expect(evaluateHost(p, "example.com", 443, "browse")).toMatchObject({ allowed: false, rule: "mode:deny" });
  });

  it("invalid hosts are denied", () => {
    const p = resolvePolicy(null, null);
    expect(evaluateHost(p, "not a host", 443, "browse").allowed).toBe(false);
  });
});

describe("precedence", () => {
  it("the workspace overrides mode, presets and the command setting", () => {
    const ws: WorkspaceEgressPolicy = { mode: "allowlist", presets: ["docs"], offPolicyCommands: "block", rules: [] };
    const p = resolvePolicy(global({ mode: "open", presets: ["packageRegistries"] }), ws);
    expect(p.mode).toBe("allowlist");
    expect(p.modeFrom).toBe("workspace");
    expect(p.presets).toEqual(["docs"]);
    expect(p.offPolicyCommands).toBe("block");
    expect(evaluateHost(p, "registry.npmjs.org", 443, "terminal").allowed).toBe(false);
    expect(evaluateHost(p, "docs.python.org", 443, "browse").allowed).toBe(true);
  });

  it("unset workspace fields inherit", () => {
    const p = resolvePolicy(global({ mode: "deny", offPolicyCommands: "block" }), { rules: [] });
    expect(p.mode).toBe("deny");
    expect(p.modeFrom).toBe("global");
    expect(p.offPolicyCommands).toBe("block");
    expect(p.presets).toEqual(DEFAULT_EGRESS_POLICY.presets);
  });

  it("deny beats allow within one scope, regardless of order", () => {
    const p = resolvePolicy(
      global({ rules: [{ action: "allow", pattern: "*.example.com" }, { action: "deny", pattern: "secret.example.com" }] }),
      null,
    );
    expect(evaluateHost(p, "www.example.com", 443, "browse").allowed).toBe(true);
    expect(evaluateHost(p, "secret.example.com", 443, "browse").allowed).toBe(false);
  });

  it("a workspace allow cannot re-open a globally denied host", () => {
    const p = resolvePolicy(
      global({ mode: "allowlist", rules: [{ action: "deny", pattern: "pastebin.com" }] }),
      { rules: [{ action: "allow", pattern: "pastebin.com" }] },
    );
    expect(evaluateHost(p, "pastebin.com", 443, "browse")).toMatchObject({ allowed: false, rule: "deny pastebin.com (global)" });
  });

  it("a workspace deny narrows a global allow", () => {
    const p = resolvePolicy(
      global({ mode: "allowlist", rules: [{ action: "allow", pattern: "*.example.com" }] }),
      { rules: [{ action: "deny", pattern: "uploads.example.com" }] },
    );
    expect(evaluateHost(p, "api.example.com", 443, "browse").allowed).toBe(true);
    expect(evaluateHost(p, "uploads.example.com", 443, "browse")).toMatchObject({ allowed: false, rule: "deny uploads.example.com (workspace)" });
  });

  it("port-scoped deny leaves other ports alone", () => {
    const p = resolvePolicy(global({ rules: [{ action: "deny", pattern: "example.com:22" }] }), null);
    expect(evaluateHost(p, "example.com", 22, "terminal").allowed).toBe(false);
    expect(evaluateHost(p, "example.com", 443, "terminal").allowed).toBe(true);
  });

  it("collects invalid stored rules instead of failing", () => {
    const p = resolvePolicy(global({ rules: [{ action: "allow", pattern: "bad pattern" }] }), null);
    expect(p.invalid).toHaveLength(1);
    expect(p.rules).toHaveLength(0);
  });
});

describe("withApprovedHosts", () => {
  it("lifts 'not on the allowlist' for approved hosts only; deny still wins", () => {
    const base = resolvePolicy(global({ mode: "allowlist", presets: [], rules: [{ action: "deny", pattern: "evil.test" }] }), null);
    const approved = withApprovedHosts(base, ["random.example", "evil.test", "*"]);
    expect(evaluateHost(approved, "random.example", 443, "terminal")).toMatchObject({ allowed: true, rule: "allow random.example (approval)" });
    expect(evaluateHost(approved, "evil.test", 443, "terminal").allowed).toBe(false);
    // A blanket `*` is never accepted as an approval.
    expect(evaluateHost(approved, "other.example", 443, "terminal").allowed).toBe(false);
    // The base policy is untouched.
    expect(evaluateHost(base, "random.example", 443, "terminal").allowed).toBe(false);
  });

  it("an approved host counts as named by a person, but metadata still needs an exact-IP rule", () => {
    const approved = withApprovedHosts(resolvePolicy(global({ mode: "allowlist", presets: [] }), null), ["intranet.example"]);
    const d = evaluateHost(approved, "intranet.example", 443, "proxy");
    expect(d.allowed).toBe(true);
    expect(checkAddress(approved, d, "10.0.0.1", 443).allowed).toBe(true);
    expect(checkAddress(approved, d, "169.254.169.254", 443).allowed).toBe(false);
  });
});

describe("implicit provider hosts", () => {
  const p = resolvePolicy(global({ mode: "deny", rules: [{ action: "deny", pattern: "api.anthropic.com" }] }), null, ["API.Anthropic.com."]);

  it("are always reachable for the harness's own model calls", () => {
    expect(evaluateHost(p, "api.anthropic.com", 443, "provider")).toMatchObject({ allowed: true, rule: "implicit:provider" });
  });

  it("give no access to other subsystems", () => {
    expect(evaluateHost(p, "api.anthropic.com", 443, "browse").allowed).toBe(false);
    expect(evaluateHost(p, "api.anthropic.com", 443, "sandbox").allowed).toBe(false);
  });

  it("only cover configured providers", () => {
    expect(evaluateHost(p, "api.openai.com", 443, "provider").allowed).toBe(false);
  });
});

describe("checkAddress (SSRF guard)", () => {
  const open = resolvePolicy(global(), null);

  it("passes public addresses and refuses private ones by default", () => {
    const d = evaluateHost(open, "example.com", 443, "browse");
    expect(checkAddress(open, d, "93.184.215.14", 443).allowed).toBe(true);
    expect(checkAddress(open, d, "10.0.0.5", 443)).toMatchObject({ allowed: false, rule: "ssrf:private" });
    expect(checkAddress(open, d, "127.0.0.1", 443)).toMatchObject({ allowed: false, rule: "ssrf:loopback" });
    expect(checkAddress(open, d, "169.254.169.254", 80)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(checkAddress(open, d, "::ffff:169.254.169.254", 80)).toMatchObject({ allowed: false, rule: "ssrf:metadata" });
    expect(checkAddress(open, d, "fe80::1", 80)).toMatchObject({ allowed: false, rule: "ssrf:link-local" });
  });

  it("an allow rule naming the host permits its private addresses", () => {
    const p = resolvePolicy(global({ rules: [{ action: "allow", pattern: "*.corp.example" }] }), null);
    const d = evaluateHost(p, "wiki.corp.example", 443, "browse");
    expect(checkAddress(p, d, "10.1.2.3", 443).allowed).toBe(true);
  });

  it("a blanket `*` allow does not count as naming the host", () => {
    const p = resolvePolicy(global({ mode: "allowlist", rules: [{ action: "allow", pattern: "*" }] }), null);
    const d = evaluateHost(p, "attacker.example", 443, "browse");
    expect(d.allowed).toBe(true);
    expect(checkAddress(p, d, "192.168.0.1", 443).allowed).toBe(false);
  });

  it("a CIDR rule permits addresses inside it", () => {
    const p = resolvePolicy(global({ rules: [{ action: "allow", pattern: "10.0.0.0/8" }] }), null);
    const d = evaluateHost(p, "anything.example", 443, "browse");
    expect(checkAddress(p, d, "10.20.30.40", 443).allowed).toBe(true);
    expect(checkAddress(p, d, "192.168.1.1", 443).allowed).toBe(false);
  });

  it("metadata needs an exact-IP rule; hostnames and ranges are not enough", () => {
    const byHost = resolvePolicy(global({ rules: [{ action: "allow", pattern: "meta.example" }, { action: "allow", pattern: "169.254.0.0/16" }] }), null);
    const d = evaluateHost(byHost, "meta.example", 80, "browse");
    expect(checkAddress(byHost, d, "169.254.169.254", 80).allowed).toBe(false);
    const exact = resolvePolicy(global({ rules: [{ action: "allow", pattern: "169.254.169.254" }] }), null);
    const d2 = evaluateHost(exact, "169.254.169.254", 80, "browse");
    expect(checkAddress(exact, d2, "169.254.169.254", 80).allowed).toBe(true);
  });

  it("IP/CIDR deny rules apply to resolved addresses", () => {
    const p = resolvePolicy(global({ rules: [{ action: "deny", pattern: "203.0.113.0/24" }] }), null);
    const d = evaluateHost(p, "innocent.example", 443, "browse");
    expect(checkAddress(p, d, "203.0.113.9", 443)).toMatchObject({ allowed: false, rule: "deny 203.0.113.0/24 (global)" });
  });
});

describe("validation", () => {
  it("accepts a well-formed global policy", () => {
    const r = sanitizePolicy({ mode: "allowlist", presets: ["docs", "docs"], rules: [{ action: "allow", pattern: "x.com", note: " n " }] });
    expect(r).toEqual({ policy: { mode: "allowlist", presets: ["docs"], rules: [{ action: "allow", pattern: "x.com", note: "n" }], offPolicyCommands: "ask" } });
  });

  it("reports every problem", () => {
    const r = sanitizePolicy({ mode: "strict", presets: ["nope"], rules: [{ action: "maybe", pattern: "x" }, { action: "allow", pattern: "a b" }], offPolicyCommands: "sometimes" });
    expect("errors" in r && r.errors.length).toBe(5);
  });

  it("workspace policies treat inherit/null as unset", () => {
    expect(sanitizeWorkspacePolicy({ mode: "inherit", presets: null, offPolicyCommands: "inherit" })).toEqual({ policy: { rules: [] } });
    expect(sanitizeWorkspacePolicy({ mode: "deny", rules: [] })).toEqual({ policy: { mode: "deny", rules: [] } });
    expect("errors" in sanitizeWorkspacePolicy({ mode: "nope" })).toBe(true);
  });
});

describe("stored settings", () => {
  const savedMode = process.env.VIBERON_EGRESS_MODE;
  beforeEach(() => {
    resetMemoryStoreForTests();
    delete process.env.VIBERON_EGRESS_MODE;
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.VIBERON_EGRESS_MODE;
    else process.env.VIBERON_EGRESS_MODE = savedMode;
  });

  it("defaults to open when nothing is stored", async () => {
    expect(await getGlobalPolicy()).toEqual(DEFAULT_EGRESS_POLICY);
    expect((await loadEffectivePolicy("repo")).mode).toBe("open");
  });

  it("merges the stored global and workspace policies", async () => {
    await setGlobalPolicy(global({ mode: "allowlist", rules: [{ action: "deny", pattern: "evil.test" }] }));
    await setWorkspacePolicy("repo-a", { mode: "deny", rules: [{ action: "allow", pattern: "ok.test" }] });
    const a = await loadEffectivePolicy("repo-a");
    const b = await loadEffectivePolicy("repo-b");
    expect(a.mode).toBe("deny");
    expect(a.rules.map((r) => `${r.action}:${r.pattern.source}:${r.origin}`)).toEqual(["deny:evil.test:global", "allow:ok.test:workspace"]);
    expect(b.mode).toBe("allowlist");
    await setWorkspacePolicy("repo-a", null);
    expect((await loadEffectivePolicy("repo-a")).mode).toBe("allowlist");
  });

  it("VIBERON_EGRESS_MODE pins the mode over both scopes", async () => {
    await setWorkspacePolicy("repo", { mode: "open", rules: [] });
    process.env.VIBERON_EGRESS_MODE = "deny";
    const p = await loadEffectivePolicy("repo");
    expect(p.mode).toBe("deny");
    expect(p.modeFrom).toBe("env");
  });
});
