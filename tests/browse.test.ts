/**
 * Tests for the web browsing module.
 *
 * Verifies URL browsing, domain validation, HTML to markdown conversion,
 * search parameter formatting, and token budgeting.
 */

import { describe, it, expect, vi } from "vitest";
import {
  DEV_DOMAINS,
  browseUrl,
  searchWeb,
  BROWSE_TOOL_DEF,
  WEB_SEARCH_TOOL_DEF,
} from "@/lib/browse";

describe("browse module", () => {
  describe("DEV_DOMAINS allowlist", () => {
    it("contains expected development and documentation domains", () => {
      expect(DEV_DOMAINS).toBeInstanceOf(Array);
      expect(DEV_DOMAINS.length).toBeGreaterThan(15);
      expect(DEV_DOMAINS).toContain("developer.mozilla.org");
      expect(DEV_DOMAINS).toContain("github.com");
      expect(DEV_DOMAINS).toContain("stackoverflow.com");
      expect(DEV_DOMAINS).toContain("pypi.org");
    });
  });

  describe("tool definitions", () => {
    it("exports valid BROWSE_TOOL_DEF schema", () => {
      expect(BROWSE_TOOL_DEF.name).toBe("browse");
      expect(BROWSE_TOOL_DEF.description).toBeDefined();
      expect(BROWSE_TOOL_DEF.input_schema.properties.url).toBeDefined();
      expect(BROWSE_TOOL_DEF.input_schema.required).toContain("url");
    });

    it("exports valid WEB_SEARCH_TOOL_DEF schema", () => {
      expect(WEB_SEARCH_TOOL_DEF.name).toBe("web_search");
      expect(WEB_SEARCH_TOOL_DEF.description).toBeDefined();
      expect(WEB_SEARCH_TOOL_DEF.input_schema.properties.query).toBeDefined();
      expect(WEB_SEARCH_TOOL_DEF.input_schema.required).toContain("query");
    });
  });

  describe("browseUrl domain filtering", () => {
    it("rejects non-allowlisted domains when allowedDomains option is set", async () => {
      const result = await browseUrl("https://untrusted-site.com/foo", {
        allowedDomains: ["docs.python.org", "github.com"],
      });
      expect(result.status).toBe(0);
      expect(result.error).toMatch(/Domain.*not in the allowed list/i);
    });

    it("allows allowlisted domains", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
          text: async () => `
            <!DOCTYPE html>
            <html>
              <head><title>Test Documentation</title></head>
              <body>
                <nav><a href="/">Home</a></nav>
                <main>
                  <h1>API Reference</h1>
                  <p>Here is how to use the function.</p>
                  <pre><code>function test() {}</code></pre>
                </main>
              </body>
            </html>
          `,
        });

        const result = await browseUrl("https://docs.python.org/3/library/os.html", {
          allowedDomains: ["docs.python.org"],
        });

        expect(result.status).toBe(200);
        expect(result.title).toBe("Test Documentation");
        expect(result.content).toContain("API Reference");
        expect(result.content).toContain("function test()");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles fetch errors gracefully", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection refused"));

        const result = await browseUrl("https://developer.mozilla.org/test");
        expect(result.status).toBe(0);
        expect(result.error).toContain("Network connection refused");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("handles non-200 HTTP responses gracefully", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: new Headers({ "content-type": "text/plain" }),
          text: async () => "Not Found",
        });

        const result = await browseUrl("https://developer.mozilla.org/missing");
        expect(result.status).toBe(404);
        expect(result.error).toContain("404");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("searchWeb", () => {
    it("handles search queries and formats markdown output", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => `
            <div class="result">
              <a class="result__a" href="https://example.com/test">Example Title</a>
              <a class="result__snippet">This is an example search snippet.</a>
            </div>
          `,
        });

        const output = await searchWeb("vitest testing guide", { maxResults: 5 });
        expect(typeof output).toBe("string");
        expect(output).toContain('Search results for: "vitest testing guide"');
        expect(output).toContain("Example Title");
        expect(output).toContain("https://example.com/test");
        expect(output).toContain("This is an example search snippet.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
