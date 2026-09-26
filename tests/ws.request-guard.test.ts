import { describe, expect, it } from "vitest";

import { guardRequest, isAllowedHost } from "@/lib/workspace/request-guard";

type Case = {
  name: string;
  method?: string;
  path?: string;
  headers: Record<string, string>;
  expect: null | 403 | 415;
};

const H = "localhost:3302";
const O = "http://localhost:3302";
const JSON_CT = { "content-type": "application/json" };

const cases: Case[] = [
  // --- allowed ---
  { name: "same-origin JSON POST", method: "POST", headers: { host: H, origin: O, "sec-fetch-site": "same-origin", ...JSON_CT }, expect: null },
  { name: "JSON with charset", method: "POST", headers: { host: H, origin: O, "content-type": "application/json; charset=utf-8" }, expect: null },
  { name: "electron 127.0.0.1 same-origin", method: "PUT", headers: { host: "127.0.0.1:51234", origin: "http://127.0.0.1:51234", ...JSON_CT }, expect: null },
  { name: "curl GET, no browser headers", method: "GET", headers: { host: H }, expect: null },
  { name: "curl JSON POST", method: "POST", headers: { host: H, ...JSON_CT }, expect: null },
  { name: "same-origin GET", method: "GET", headers: { host: H, "sec-fetch-site": "same-origin" }, expect: null },
  { name: "typed URL (sec-fetch-site none)", method: "GET", headers: { host: H, "sec-fetch-site": "none" }, expect: null },
  { name: "bodyless DELETE", method: "DELETE", headers: { host: H, origin: O }, expect: null },
  { name: "IPv6 loopback", method: "GET", headers: { host: "[::1]:3000" }, expect: null },
  { name: "page (non-api) cross-site nav", method: "GET", path: "/", headers: { host: H, "sec-fetch-site": "cross-site" }, expect: null },

  // --- host / DNS rebinding ---
  { name: "rebinding host", method: "GET", headers: { host: "evil.com:3302" }, expect: 403 },
  { name: "rebinding host on page", method: "GET", path: "/", headers: { host: "evil.com" }, expect: 403 },
  { name: "missing host", method: "GET", headers: {}, expect: 403 },
  { name: "localhost suffix trick", method: "GET", headers: { host: "localhost.evil.com" }, expect: 403 },
  { name: "localhost prefix trick", method: "GET", headers: { host: "evil-localhost:3000" }, expect: 403 },
  { name: "userinfo trick", method: "GET", headers: { host: "localhost@evil.com" }, expect: 403 },
  { name: "0.0.0.0", method: "GET", headers: { host: "0.0.0.0:3000" }, expect: 403 },
  { name: "LAN IP", method: "GET", headers: { host: "192.168.1.5:3000" }, expect: 403 },

  // --- cross origin ---
  { name: "cross-origin POST", method: "POST", headers: { host: H, origin: "https://evil.com", ...JSON_CT }, expect: 403 },
  { name: "other localhost port", method: "POST", headers: { host: H, origin: "http://localhost:5173", ...JSON_CT }, expect: 403 },
  { name: "localhost vs 127.0.0.1", method: "POST", headers: { host: H, origin: "http://127.0.0.1:3302", ...JSON_CT }, expect: 403 },
  { name: "null origin (sandboxed iframe)", method: "POST", headers: { host: H, origin: "null", ...JSON_CT }, expect: 403 },
  { name: "garbage origin", method: "POST", headers: { host: H, origin: "not a url", ...JSON_CT }, expect: 403 },
  { name: "file origin", method: "POST", headers: { host: H, origin: "file://", ...JSON_CT }, expect: 403 },
  { name: "cross-site GET via img", method: "GET", headers: { host: H, "sec-fetch-site": "cross-site" }, expect: 403 },
  { name: "same-site GET (other port)", method: "GET", headers: { host: H, "sec-fetch-site": "same-site" }, expect: 403 },
  { name: "origin match but fetch-site cross-site", method: "POST", headers: { host: H, origin: O, "sec-fetch-site": "cross-site", ...JSON_CT }, expect: 403 },

  // --- content type ---
  { name: "text/plain no-cors POST", method: "POST", headers: { host: H, "content-type": "text/plain" }, expect: 415 },
  { name: "form POST", method: "POST", headers: { host: H, origin: O, "content-type": "application/x-www-form-urlencoded" }, expect: 415 },
  { name: "multipart POST", method: "POST", headers: { host: H, "content-type": "multipart/form-data; boundary=x" }, expect: 415 },
  { name: "POST without content-type", method: "POST", headers: { host: H }, expect: 415 },
  { name: "json lookalike", method: "POST", headers: { host: H, "content-type": "application/jsonp" }, expect: 415 },
  { name: "text/plain with json param", method: "POST", headers: { host: H, "content-type": "text/plain; application/json" }, expect: 415 },
  { name: "PATCH text", method: "PATCH", headers: { host: H, "content-type": "text/plain" }, expect: 415 },
  { name: "DELETE with text body", method: "DELETE", headers: { host: H, "content-type": "text/plain", "content-length": "5" }, expect: 415 },
  { name: "lowercase method", method: "post", headers: { host: H, "content-type": "text/plain" }, expect: 415 },
];

describe("guardRequest", () => {
  it.each(cases)("$name", (c) => {
    const result = guardRequest({
      method: c.method ?? "GET",
      pathname: c.path ?? "/api/terminal",
      headers: new Headers(c.headers),
    });
    expect(result?.status ?? null).toBe(c.expect);
  });

  it("isAllowedHost honours VIBERON_ALLOWED_HOSTS", () => {
    expect(isAllowedHost("myhost:3000")).toBe(false);
    process.env.VIBERON_ALLOWED_HOSTS = "myhost";
    try {
      expect(isAllowedHost("myhost:3000")).toBe(true);
    } finally {
      delete process.env.VIBERON_ALLOWED_HOSTS;
    }
  });
});
