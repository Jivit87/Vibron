import { describe, expect, it } from "vitest";

import { normalizeHost, parseHostPort, targetFromUrl } from "@/lib/egress/host";
import { cidrContains, classifyIp, embeddedIPv4, parseCidr, parseIp, parseIPv6 } from "@/lib/egress/ip";
import { matchPattern, parsePattern, type HostPattern } from "@/lib/egress/rules";

function pattern(text: string): HostPattern {
  const p = parsePattern(text);
  if (typeof p === "string") throw new Error(p);
  return p;
}

/** Match against a raw host the way the policy does: normalize first. */
function matches(rule: string, host: string, port: number | null = 443): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) throw new Error(`bad host ${host}`);
  return matchPattern(pattern(rule), normalized, port);
}

describe("normalizeHost", () => {
  it("lowercases, strips trailing dots and converts IDNs to punycode", () => {
    expect(normalizeHost("Example.COM")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("example.com..")).toBe("example.com");
    expect(normalizeHost("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeHost("MÜNCHEN.DE.")).toBe("xn--mnchen-3ya.de");
    expect(normalizeHost("xn--mnchen-3ya.de")).toBe("xn--mnchen-3ya.de");
  });

  it("folds the odd IPv4 spellings into dotted quads", () => {
    expect(normalizeHost("127.1")).toBe("127.0.0.1");
    expect(normalizeHost("0x7f.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHost("2130706433")).toBe("127.0.0.1");
    expect(normalizeHost("0251.0376.0251.0376")).toBe("169.254.169.254");
  });

  it("canonicalizes IPv6 with or without brackets", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(normalizeHost("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeHost("[fe80::1%en0]")).toBe("fe80::1");
  });

  it("rejects things that are not hosts", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("a b.com")).toBeNull();
    expect(normalizeHost("user@host.com")).toBeNull();
    expect(normalizeHost("host.com:80")).toBeNull();
    expect(normalizeHost("[not-ipv6]")).toBeNull();
    expect(normalizeHost("...")).toBeNull();
  });
});

describe("targetFromUrl / parseHostPort", () => {
  it("fills in the scheme's default port", () => {
    expect(targetFromUrl("https://Example.com./x?y")).toEqual({ host: "example.com", port: 443, scheme: "https" });
    expect(targetFromUrl("http://example.com:8080/")).toEqual({ host: "example.com", port: 8080, scheme: "http" });
    expect(targetFromUrl("http://[::ffff:127.0.0.1]/")?.host).toBe("::ffff:7f00:1");
    expect(targetFromUrl("not a url")).toBeNull();
  });

  it("splits host and port, including bracketed IPv6", () => {
    expect(parseHostPort("example.com:8443")).toEqual({ host: "example.com", port: 8443 });
    expect(parseHostPort("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1", port: null });
    expect(parseHostPort("example.com:99999")).toBeNull();
    expect(parseHostPort("example.com:0")).toBeNull();
  });
});

describe("IP parsing and classification", () => {
  it("parses IPv6 forms, including an embedded IPv4 tail", () => {
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("12345::")).toBeNull();
  });

  it("classifies private, loopback, link-local and metadata addresses", () => {
    const cls = (a: string) => classifyIp(parseIp(a)!);
    expect(cls("8.8.8.8")).toBe("public");
    expect(cls("127.0.0.53")).toBe("loopback");
    expect(cls("10.1.2.3")).toBe("private");
    expect(cls("172.20.0.1")).toBe("private");
    expect(cls("192.168.1.1")).toBe("private");
    expect(cls("100.64.0.1")).toBe("private");
    expect(cls("169.254.1.1")).toBe("link-local");
    expect(cls("169.254.169.254")).toBe("metadata");
    expect(cls("100.100.100.200")).toBe("metadata");
    expect(cls("fd00:ec2::254")).toBe("metadata");
    expect(cls("0.0.0.0")).toBe("reserved");
    expect(cls("::1")).toBe("loopback");
    expect(cls("fe80::1")).toBe("link-local");
    expect(cls("fd12:3456::1")).toBe("private");
    expect(cls("2606:4700::1111")).toBe("public");
    // IPv4 hiding inside IPv6.
    expect(cls("::ffff:127.0.0.1")).toBe("loopback");
    expect(cls("::ffff:169.254.169.254")).toBe("metadata");
    expect(cls("64:ff9b::a9fe:a9fe")).toBe("metadata");
  });

  it("matches CIDR ranges, including IPv4 rules against mapped IPv6", () => {
    const net = parseCidr("10.0.0.0/8")!;
    expect(cidrContains(net, parseIp("10.200.1.1")!)).toBe(true);
    expect(cidrContains(net, parseIp("11.0.0.1")!)).toBe(false);
    expect(cidrContains(net, parseIp("::ffff:10.0.0.1")!)).toBe(true);
    const v6 = parseCidr("2001:db8::/33")!;
    expect(cidrContains(v6, parseIp("2001:db8:7fff::1")!)).toBe(true);
    expect(cidrContains(v6, parseIp("2001:db8:8000::1")!)).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(embeddedIPv4(parseIPv6("::1")!)).toBeNull();
  });
});

describe("host patterns", () => {
  it("exact hosts match any port unless one is given", () => {
    expect(matches("example.com", "example.com", 443)).toBe(true);
    expect(matches("example.com", "example.com", 8080)).toBe(true);
    expect(matches("example.com", "www.example.com")).toBe(false);
    expect(matches("example.com:8443", "example.com", 8443)).toBe(true);
    expect(matches("example.com:8443", "example.com", 443)).toBe(false);
    expect(matches("example.com:8443", "example.com", null)).toBe(false);
  });

  it("wildcards cover subdomains at any depth but not the apex", () => {
    expect(matches("*.example.com", "api.example.com")).toBe(true);
    expect(matches("*.example.com", "a.b.example.com")).toBe(true);
    expect(matches("*.example.com", "example.com")).toBe(false);
    expect(matches("*.example.com", "badexample.com")).toBe(false);
    expect(matches("*.example.com", "example.com.evil.test")).toBe(false);
    expect(matches("*.example.com:443", "api.example.com", 80)).toBe(false);
  });

  it("normalizes case, punycode and trailing dots on both sides", () => {
    expect(matches("EXAMPLE.com.", "example.COM.")).toBe(true);
    expect(matches("*.Example.Com", "API.EXAMPLE.COM.")).toBe(true);
    expect(matches("münchen.de", "xn--mnchen-3ya.de")).toBe(true);
    expect(matches("*.xn--mnchen-3ya.de", "www.münchen.de")).toBe(true);
  });

  it("matches IP literals by value, not spelling", () => {
    expect(matches("127.0.0.1", "0x7f.0.0.1")).toBe(true);
    expect(matches("169.254.169.254", "2852039166")).toBe(true);
    expect(matches("::1", "[0:0::1]")).toBe(true);
    expect(matches("[2001:db8::1]:443", "2001:DB8::0:1", 443)).toBe(true);
    expect(matches("[2001:db8::1]:443", "2001:db8::1", 80)).toBe(false);
    expect(matches("127.0.0.1", "::ffff:127.0.0.1")).toBe(true);
    expect(matches("10.0.0.0/8", "10.9.9.9")).toBe(true);
    expect(matches("fd00::/8", "fd12::1")).toBe(true);
    expect(matches("10.0.0.0/8", "internal.example")).toBe(false);
  });

  it("accepts a pasted URL and the catch-all", () => {
    expect(matches("https://Docs.Example.com/path?q=1", "docs.example.com", 443)).toBe(true);
    expect(matches("https://docs.example.com:9000/", "docs.example.com", 443)).toBe(false);
    expect(matches("*", "anything.test")).toBe(true);
    expect(matches("*:22", "anything.test", 443)).toBe(false);
  });

  it("rejects malformed patterns with a message", () => {
    for (const bad of ["", "exa mple.com", "*.1.2.3.4", "foo.*.com", "**.x.com", "10.0.0.0/99", "host:70000", "http://"]) {
      expect(typeof parsePattern(bad)).toBe("string");
    }
  });
});
