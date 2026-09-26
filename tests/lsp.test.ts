/**
 * Tests for the LSP (Language Server Protocol) integration module.
 *
 * Verifies server discovery, diagnostic formatting, and LspManager lifecycle.
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectAvailableServers,
  LspManager,
  type Diagnostic,
} from "@/lib/lsp";

describe("lsp module", () => {
  describe("detectAvailableServers", () => {
    it("returns an array of server configurations", () => {
      const servers = detectAvailableServers();
      expect(Array.isArray(servers)).toBe(true);
      for (const server of servers) {
        expect(server).toHaveProperty("language");
        expect(server).toHaveProperty("command");
        expect(server).toHaveProperty("args");
        expect(server).toHaveProperty("extensions");
        expect(Array.isArray(server.extensions)).toBe(true);
      }
    });
  });

  describe("LspManager", () => {
    it("initializes with workspace root", () => {
      const manager = new LspManager(process.cwd());
      expect(manager).toBeDefined();
      expect(Array.isArray(manager.supportedLanguages)).toBe(true);
      expect(typeof manager.hasServers).toBe("boolean");
    });

    it("returns empty string when no diagnostics exist", async () => {
      const manager = new LspManager(process.cwd());
      const formatted = await manager.getDiagnosticsAfterEdit(
        "non-existent-file.xyz",
        "content"
      );
      expect(formatted).toBe("");
    });

    it("formats diagnostics properly", async () => {
      const manager = new LspManager(process.cwd());
      const relPath = "src/main.ts";

      // Configure a synthetic typescript server config
      (manager as any).availableServers = [
        {
          language: "typescript",
          command: "tsserver",
          args: [],
          extensions: [".ts"],
        },
      ];

      const fakeDiags: Diagnostic[] = [
        {
          file: relPath,
          line: 12,
          column: 5,
          severity: "error",
          message: "Cannot find name 'foo'",
          source: "typescript",
        },
        {
          file: relPath,
          line: 25,
          column: 1,
          severity: "warning",
          message: "'bar' is declared but its value is never read",
          source: "typescript",
        },
      ];

      (manager as any).connections.set("typescript", {
        config: {
          language: "typescript",
          command: "tsserver",
          args: [],
          extensions: [".ts"],
        },
        diagnostics: new Map([[relPath, fakeDiags]]),
        nextId: 1,
        pending: new Map(),
        initialized: true,
        buffer: "",
        process: { kill: vi.fn() },
      });

      const diags = await manager.getDiagnostics(relPath);
      expect(diags).toHaveLength(2);

      const all = manager.getAllDiagnostics();
      expect(all).toHaveLength(2);
      expect(all[0].message).toBe("Cannot find name 'foo'");
      expect(all[1].severity).toBe("warning");

      // Verify diagnostic message formatting
      const formatted = await manager.getDiagnosticsAfterEdit(relPath, "const foo = 1;");
      expect(formatted).toContain("[LSP] 1 error(s) detected:");
      expect(formatted).toContain("Cannot find name 'foo'");
      expect(formatted).toContain("[LSP] 1 warning(s):");
      expect(formatted).toContain("'bar' is declared but its value is never read");
    });
  });
});
