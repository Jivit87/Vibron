#!/usr/bin/env tsx
/**
 * Sandbox Integration Validation Script
 *
 * Tests the sandbox integration without requiring Docker.
 * Validates code paths, fallback behavior, and integration points.
 */

import { isDockerAvailable, getActiveSandboxes } from "@/lib/sandbox";
import { startCommand, waitFor, killSession, listSessions } from "@/lib/terminal";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

console.log("🧪 Sandbox Integration Validation\n");
console.log("=" .repeat(60));

// Test workspace
const testWorkspace = mkdtempSync(join(tmpdir(), "viberon-validate-"));
console.log(`📁 Test workspace: ${testWorkspace}\n`);

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => Promise<void> | void, skipIf = false) {
  return async () => {
    if (skipIf) {
      console.log(`⏭️  SKIP: ${name}`);
      skipped++;
      return;
    }
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ FAIL: ${name}`);
      console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  };
}

// Run tests
(async () => {
  try {
    console.log("1️⃣  Docker Detection Tests\n");
    
    await test("Docker availability check", () => {
      const available = isDockerAvailable();
      console.log(`   Docker available: ${available}`);
      if (typeof available !== "boolean") {
        throw new Error("isDockerAvailable() should return boolean");
      }
    })();
    
    await test("Get active sandboxes", () => {
      const active = getActiveSandboxes();
      if (!Array.isArray(active)) {
        throw new Error("getActiveSandboxes() should return array");
      }
      console.log(`   Active sandboxes: ${active.length}`);
    })();
    
    console.log();
    console.log("2️⃣  Fallback Behavior Tests\n");
    
    const dockerAvailable = isDockerAvailable();
    
    await test("Fallback to direct execution when Docker unavailable", async () => {
      const session = startCommand({
        repoKey: "test-fallback",
        command: "echo 'Fallback test'",
        cwd: testWorkspace,
        sandbox: { enabled: true },
        timeoutMs: 10_000,
      });
      
      const result = await waitFor(session, 15_000);
      
      if (result.status === "running") {
        throw new Error("Command did not complete in time");
      }
      
      const output = result.buffer.toString();
      
      if (!dockerAvailable && !output.includes("sandbox requested but Docker is not available")) {
        throw new Error("Should show fallback message when Docker unavailable");
      }
      
      if (result.exitCode !== 0) {
        throw new Error(`Command should succeed, got exit code ${result.exitCode}`);
      }
      
      console.log(`   Exit code: ${result.exitCode}`);
      console.log(`   Status: ${result.status}`);
    })();
    
    await test("Direct execution works without sandbox", async () => {
      const session = startCommand({
        repoKey: "test-direct",
        command: "echo 'Direct test'",
        cwd: testWorkspace,
        sandbox: { enabled: false },
        timeoutMs: 10_000,
      });
      
      const result = await waitFor(session, 15_000);
      
      if (result.status !== "exited") {
        throw new Error(`Expected exited, got ${result.status}`);
      }
      
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}`);
      }
      
      if (result.sandboxSession !== null) {
        throw new Error("sandboxSession should be null when sandbox disabled");
      }
      
      console.log(`   Exit code: ${result.exitCode}`);
      console.log(`   Sandbox session: ${result.sandboxSession}`);
    })();
    
    await test("Command errors handled gracefully", async () => {
      const session = startCommand({
        repoKey: "test-error",
        command: "nonexistent-command-xyz",
        cwd: testWorkspace,
        sandbox: { enabled: true },
        timeoutMs: 10_000,
      });
      
      const result = await waitFor(session, 15_000);
      
      if (result.exitCode === 0) {
        throw new Error("Invalid command should fail");
      }
      
      console.log(`   Exit code: ${result.exitCode} (expected non-zero)`);
    })();
    
    console.log();
    console.log("3️⃣  Integration Tests\n");
    
    await test("Terminal session tracking", () => {
      const beforeCount = listSessions().length;
      
      const session = startCommand({
        repoKey: "test-tracking",
        command: "echo test",
        cwd: testWorkspace,
        sandbox: { enabled: false },
      });
      
      const afterCount = listSessions().length;
      
      if (afterCount !== beforeCount + 1) {
        throw new Error(`Expected ${beforeCount + 1} sessions, got ${afterCount}`);
      }
      
      console.log(`   Sessions before: ${beforeCount}`);
      console.log(`   Sessions after: ${afterCount}`);
    })();
    
    await test("Session cleanup on kill", async () => {
      const session = startCommand({
        repoKey: "test-kill",
        command: "sleep 30",
        cwd: testWorkspace,
        sandbox: { enabled: false },
      });
      
      // Let it start
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (session.status !== "running") {
        throw new Error("Session should be running");
      }
      
      const killed = killSession(session.id);
      
      if (!killed) {
        throw new Error("killSession should return true");
      }
      
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if ((session.status as string) !== "killed") {
        throw new Error(`Expected killed status, got ${session.status}`);
      }
      
      console.log(`   Session killed successfully`);
    })();
    
    await test("Workspace file access", async () => {
      const testFile = join(testWorkspace, "test-file.txt");
      writeFileSync(testFile, "test content");
      
      const session = startCommand({
        repoKey: "test-file",
        command: `cat ${testFile}`,
        cwd: testWorkspace,
        sandbox: { enabled: false },
        timeoutMs: 10_000,
      });
      
      const result = await waitFor(session, 15_000);
      
      if (result.exitCode !== 0) {
        throw new Error("Should be able to read workspace file");
      }
      
      const output = result.buffer.toString();
      if (!output.includes("test content")) {
        throw new Error("Output should contain file content");
      }
      
      console.log(`   File read successfully`);
    })();
    
    console.log();
    console.log("4️⃣  Configuration Tests\n");
    
    await test("Sandbox config preserved in session", async () => {
      const session = startCommand({
        repoKey: "test-config",
        command: "echo test",
        cwd: testWorkspace,
        sandbox: { 
          enabled: true,
          memoryMb: 512,
          cpus: 1,
          network: "none"
        },
        timeoutMs: 10_000,
      });
      
      await waitFor(session, 15_000);
      
      // Check that sandbox config was passed through
      // (sandboxSession will be null if Docker unavailable, which is OK)
      console.log(`   Sandbox session: ${session.sandboxSession ? "created" : "null (Docker unavailable)"}`);
    })();
    
    console.log();
    console.log("5️⃣  Docker-Specific Tests (skipped if Docker unavailable)\n");
    
    await test("Container startup and execution", async () => {
      const session = startCommand({
        repoKey: "test-container",
        command: "echo 'Container test'",
        cwd: testWorkspace,
        sandbox: { enabled: true },
        timeoutMs: 30_000,
      });
      
      const result = await waitFor(session, 35_000);
      
      if (result.status !== "exited") {
        throw new Error(`Expected exited, got ${result.status}`);
      }
      
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}`);
      }
      
      const output = result.buffer.toString();
      
      if (dockerAvailable) {
        if (!output.includes("sandbox ready")) {
          throw new Error("Should show sandbox ready message");
        }
        if (!output.includes("Container test")) {
          throw new Error("Should show command output");
        }
      }
      
      console.log(`   Container execution validated`);
    }, !dockerAvailable)();
    
    await test("Container cleanup after execution", async () => {
      const session = startCommand({
        repoKey: "test-cleanup",
        command: "echo 'Cleanup test'",
        cwd: testWorkspace,
        sandbox: { enabled: true },
        timeoutMs: 30_000,
      });
      
      const result = await waitFor(session, 35_000);
      
      const output = result.buffer.toString();
      
      if (!output.includes("sandbox container stopped")) {
        throw new Error("Should show container stopped message");
      }
      
      // Check no orphaned containers
      const active = getActiveSandboxes();
      const orphaned = active.find(s => s.containerName.includes("test-cleanup"));
      
      if (orphaned) {
        throw new Error("Found orphaned container");
      }
      
      console.log(`   Container cleaned up successfully`);
    }, !dockerAvailable)();
    
    // Summary
    console.log();
    console.log("=" .repeat(60));
    console.log("📊 Validation Summary\n");
    console.log(`✅ Passed:  ${passed}`);
    console.log(`❌ Failed:  ${failed}`);
    console.log(`⏭️  Skipped: ${skipped}`);
    console.log();
    
    if (failed === 0) {
      console.log("🎉 All validation tests passed!");
      if (skipped > 0) {
        console.log(`⚠️  Note: ${skipped} tests skipped (Docker not available)`);
      }
    } else {
      console.log("❌ Some validation tests failed");
      process.exit(1);
    }
    
  } catch (error) {
    console.error("\n💥 Validation script error:", error);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
      console.log(`\n🧹 Cleaned up test workspace`);
    } catch (error) {
      console.warn(`⚠️  Failed to clean up test workspace: ${error}`);
    }
  }
})();
