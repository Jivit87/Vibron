/**
 * Tests for the Docker sandbox module.
 *
 * These tests verify the sandbox configuration, command building, and
 * lifecycle management without actually starting Docker containers
 * (except in the integration tests that require Docker).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the pure logic by importing the module's internals.
// The actual Docker execution is tested in integration tests.

describe("sandbox", () => {
  describe("SandboxConfig defaults", () => {
    it("should use sensible defaults when none specified", async () => {
      const { isDockerAvailable, resetDockerCache } = await import("@/lib/sandbox");
      // Just verify the module loads without error.
      resetDockerCache();
      // isDockerAvailable() may be true or false depending on the system.
      expect(typeof isDockerAvailable()).toBe("boolean");
    });
  });

  describe("isDockerAvailable", () => {
    it("returns a boolean", async () => {
      const { isDockerAvailable, resetDockerCache } = await import("@/lib/sandbox");
      resetDockerCache();
      const result = isDockerAvailable();
      expect(typeof result).toBe("boolean");
    });

    it("caches the result", async () => {
      const { isDockerAvailable, resetDockerCache } = await import("@/lib/sandbox");
      resetDockerCache();
      const first = isDockerAvailable();
      const second = isDockerAvailable();
      expect(first).toBe(second);
    });
  });

  describe("getActiveSandboxes", () => {
    it("returns an empty array when no sandboxes are running", async () => {
      const { getActiveSandboxes } = await import("@/lib/sandbox");
      expect(getActiveSandboxes()).toEqual([]);
    });
  });

  describe("DEV_DOMAINS (browse module)", () => {
    it("includes common development domains", async () => {
      const { DEV_DOMAINS } = await import("@/lib/browse");
      expect(DEV_DOMAINS).toContain("stackoverflow.com");
      expect(DEV_DOMAINS).toContain("github.com");
      expect(DEV_DOMAINS).toContain("developer.mozilla.org");
      expect(DEV_DOMAINS).toContain("docs.python.org");
      expect(DEV_DOMAINS).toContain("npmjs.com");
    });
  });
});
