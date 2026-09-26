import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cancelRun,
  createRun,
  getRun,
  requestApproval,
  resetRunsForTests,
  resolveApproval,
} from "@/lib/harness/runs";
import { startRunCommand } from "@/lib/harness/workspace-services";
import { getSession } from "@/lib/terminal";
import { eventLog } from "./helpers/harness-workspace";

afterEach(() => resetRunsForTests());

const ask = { kind: "command" as const, title: "npm publish", reason: "not on the list" };

describe("run approvals", () => {
  it("emits a request carrying the real agent id, and resolves on allow", async () => {
    const log = eventLog();
    const run = createRun("repo", log.emit);
    const pending = requestApproval(run.runId, "backend", ask);
    const request = log.of("approval_request")[0];
    expect(request).toMatchObject({ agentId: "backend", kind: "command", title: "npm publish", command: "npm publish" });
    expect(resolveApproval(request.approvalId, "allow")).toBe(true);
    expect(await pending).toBe(true);
    expect(log.of("approval_resolved")[0]).toMatchObject({ approvalId: request.approvalId, decision: "allow" });
    // Already settled.
    expect(resolveApproval(request.approvalId, "deny")).toBe(false);
  });

  it("cancel denies only that run's approvals", async () => {
    const a = eventLog();
    const b = eventLog();
    const runA = createRun("repo", a.emit);
    const runB = createRun("repo", b.emit);
    const pendingA = requestApproval(runA.runId, "x", ask);
    const pendingB = requestApproval(runB.runId, "y", ask);

    expect(cancelRun(runA.runId)).toBe(true);
    expect(await pendingA).toBe(false);
    expect(a.of("approval_resolved")[0].decision).toBe("cancelled");
    expect(runA.signal.aborted).toBe(true);

    // Run B is untouched and still waiting.
    expect(b.of("approval_resolved")).toHaveLength(0);
    expect(resolveApproval(b.of("approval_request")[0].approvalId, "allow")).toBe(true);
    expect(await pendingB).toBe(true);
    expect(getRun(runB.runId)?.signal.aborted).toBe(false);
  });

  it("refuses immediately once the run is cancelled", async () => {
    const run = createRun("repo", () => {});
    cancelRun(run.runId);
    expect(await requestApproval(run.runId, "x", ask)).toBe(false);
    expect(cancelRun("nope")).toBe(false);
  });

  it("allow_always skips the prompt for the same key in the same workspace", async () => {
    const log = eventLog();
    const run = createRun("repo", log.emit);
    const first = requestApproval(run.runId, "x", ask);
    resolveApproval(log.of("approval_request")[0].approvalId, "allow_always");
    expect(await first).toBe(true);

    expect(await requestApproval(run.runId, "x", ask)).toBe(true);
    expect(log.of("approval_request")).toHaveLength(1);

    // A different command still asks.
    void requestApproval(run.runId, "x", { ...ask, title: "rm -rf build" });
    expect(log.of("approval_request")).toHaveLength(2);
  });
});

describe("cancel kills the run's terminal sessions", () => {
  it("kills a background command started by the run", async () => {
    const run = createRun("repo", () => {});
    const cwd = mkdtempSync(path.join(tmpdir(), "viberon-runs-"));
    const session = startRunCommand({
      repoKey: "repo",
      command: "sleep 30",
      cwd,
      runId: run.runId,
      signal: run.signal,
      origin: "agent",
    });
    expect(session.status).toBe("running");
    cancelRun(run.runId);
    expect(getSession(session.id)?.status).toBe("killed");
  });
});
