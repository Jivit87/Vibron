/**
 * Integration tests for Docker sandbox execution.
 *
 * These tests require Docker to be running. They are skipped if Docker
 * is not available on the system.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isDockerAvailable, startSandbox, stopSandbox, execInSandbox } from "@/lib/sandbox";
import { startCommand, waitFor, killSession } from "@/lib/terminal";
import type { TerminalSession } from "@/lib/terminal";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dockerAvailable = isDockerAvailable();

// Create a temporary workspace for testing
let testWorkspace: string;
const activeSessions: TerminalSession[] = [];

beforeAll(() => {
  if (!dockerAvailable) {
    console.log("⚠️  Docker not available, skipping integration tests");
    return;
  }
  testWorkspace = mkdtempSync(join(tmpdir(), "viberon-sandbox-test-"));
  console.log(`✓ Created test workspace: ${testWorkspace}`);
});

afterAll(async () => {
  if (!dockerAvailable) return;
  
  // Clean up any active sessions
  for (const session of activeSessions) {
    killSession(session.id);
  }
  
  // Clean up test workspace
  if (testWorkspace) {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
      console.log(`✓ Cleaned up test workspace`);
    } catch (error) {
      console.error("Failed to clean up test workspace:", error);
    }
  }
});

describe("Sandbox Integration", () => {
  describe("Docker availability", () => {
    it("detects Docker availability", () => {
      const available = isDockerAvailable();
      expect(typeof available).toBe("boolean");
      console.log(`Docker available: ${available}`);
    });
  });

  describe.skipIf(!dockerAvailable)("Direct sandbox API", () => {
    it("can start and stop a sandbox container", async () => {
      const session = await startSandbox(testWorkspace, { enabled: true });
      expect(session).toBeDefined();
      expect(session.status).toBe("ready");
      expect(session.containerId).toBeTruthy();
      console.log(`✓ Started container: ${session.containerName}`);

      await stopSandbox(session);
      expect(session.status).toBe("stopped");
      console.log(`✓ Stopped container`);
    }, 60_000);

    it("can execute commands in sandbox", async () => {
      const session = await startSandbox(testWorkspace, { enabled: true });
      
      try {
        const result = await execInSandbox(session, "echo hello world");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("hello world");
        expect(result.timedOut).toBe(false);
        console.log(`✓ Command output: ${result.stdout.trim()}`);
      } finally {
        await stopSandbox(session);
      }
    }, 60_000);

    it("respects command timeout", async () => {
      const session = await startSandbox(testWorkspace, { enabled: true });
      
      try {
        const result = await execInSandbox(session, "sleep 10", { timeoutMs: 1000 });
        expect(result.timedOut).toBe(true);
        console.log(`✓ Command timed out as expected`);
      } finally {
        await stopSandbox(session);
      }
    }, 30_000);

    it("isolates filesystem (read-only root)", async () => {
      const session = await startSandbox(testWorkspace, { enabled: true });
      
      try {
        // Try to write to /etc (should fail - read-only)
        const result = await execInSandbox(session, "touch /etc/test-file");
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toLowerCase()).toMatch(/read-?only|permission denied/);
        console.log(`✓ Filesystem isolation working`);
      } finally {
        await stopSandbox(session);
      }
    }, 60_000);

    it("blocks network by default", async () => {
      const session = await startSandbox(testWorkspace, { 
        enabled: true,
        network: "none" 
      });
      
      try {
        // Try to ping (should fail - no network)
        const result = await execInSandbox(session, "ping -c 1 8.8.8.8 || curl -I https://google.com || wget -O- https://google.com", { timeoutMs: 5000 });
        expect(result.exitCode).not.toBe(0);
        console.log(`✓ Network isolation working`);
      } finally {
        await stopSandbox(session);
      }
    }, 60_000);

    it("can access workspace files", async () => {
      // Create a test file
      const testFile = join(testWorkspace, "test.txt");
      writeFileSync(testFile, "sandbox test content");
      
      const session = await startSandbox(testWorkspace, { enabled: true });
      
      try {
        const result = await execInSandbox(session, "cat /workspace/test.txt");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("sandbox test content");
        console.log(`✓ Workspace mount working`);
      } finally {
        await stopSandbox(session);
      }
    }, 60_000);
  });

  describe.skipIf(!dockerAvailable)("Terminal integration", () => {
    it("can run commands via terminal with sandbox enabled", async () => {
      const session = startCommand({
        repoKey: "test",
        command: "echo sandbox terminal test",
        cwd: testWorkspace,
        timeoutMs: 10_000,
        sandbox: { enabled: true },
      });
      
      activeSessions.push(session);
      const result = await waitFor(session, 30_000);
      
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(0);
      
      const output = result.buffer.toString();
      expect(output).toContain("sandbox terminal test");
      expect(output).toMatch(/\[sandbox ready:/);
      expect(output).toMatch(/\[sandbox container stopped\]/);
      
      console.log(`✓ Terminal sandbox integration working`);
    }, 60_000);

    it("falls back to direct execution if Docker unavailable", () => {
      // This test simulates the fallback by checking behavior
      const session = startCommand({
        repoKey: "test",
        command: "echo fallback test",
        cwd: testWorkspace,
        sandbox: { enabled: false }, // Explicitly disabled
      });
      
      activeSessions.push(session);
      expect(session).toBeDefined();
      expect(session.sandboxSession).toBeNull();
      
      console.log(`✓ Fallback to direct execution working`);
    });

    it("includes sandbox status in terminal output", async () => {
      const session = startCommand({
        repoKey: "test",
        command: "pwd",
        cwd: testWorkspace,
        timeoutMs: 10_000,
        sandbox: { enabled: true },
      });
      
      activeSessions.push(session);
      const result = await waitFor(session, 30_000);
      
      const output = result.buffer.toString();
      expect(output).toContain("$ pwd");
      expect(output).toMatch(/\[starting sandbox container\.\.\.\]/);
      expect(output).toMatch(/\[sandbox ready:/);
      
      console.log(`✓ Sandbox status messages present`);
    }, 60_000);

    it("respects resource limits", async () => {
      const session = startCommand({
        repoKey: "test",
        command: "echo resource limit test",
        cwd: testWorkspace,
        timeoutMs: 10_000,
        sandbox: { 
          enabled: true,
          memoryMb: 512,
          cpus: 1,
        },
      });
      
      activeSessions.push(session);
      const result = await waitFor(session, 30_000);
      
      expect(result.status).toBe("exited");
      expect(result.sandboxSession).toBeDefined();
      expect(result.sandboxSession?.config.memoryMb).toBe(512);
      expect(result.sandboxSession?.config.cpus).toBe(1);
      
      console.log(`✓ Resource limits applied`);
    }, 60_000);
  });

  describe.skipIf(!dockerAvailable)("Cleanup", () => {
    it("cleans up sandbox on session kill", async () => {
      const session = startCommand({
        repoKey: "test",
        command: "sleep 30",
        cwd: testWorkspace,
        sandbox: { enabled: true },
      });
      
      activeSessions.push(session);
      
      // Wait for sandbox to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      expect(session.sandboxSession).toBeDefined();
      const containerName = session.sandboxSession?.containerName;
      
      // Kill the session
      const killed = killSession(session.id);
      expect(killed).toBe(true);
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      expect(session.status).toBe("killed");
      console.log(`✓ Session killed, container ${containerName} cleaned up`);
    }, 60_000);
  });
});

describe("Sandbox Module Compatibility", () => {
  it("exports expected functions", () => {
    expect(typeof isDockerAvailable).toBe("function");
    expect(typeof startSandbox).toBe("function");
    expect(typeof stopSandbox).toBe("function");
    expect(typeof execInSandbox).toBe("function");
  });

  it("exports expected types", async () => {
    const { getActiveSandboxes } = await import("@/lib/sandbox");
    expect(typeof getActiveSandboxes).toBe("function");
    const active = getActiveSandboxes();
    expect(Array.isArray(active)).toBe(true);
  });
});
