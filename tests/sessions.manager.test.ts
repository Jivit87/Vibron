import { afterEach, describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { claimFile, listLocks, resetFileLocksForTests } from "@/lib/sessions/file-locks";
import {
  normalizeConfig,
  SessionError,
  SessionManager,
  statusForRun,
  type WorktreeDeps,
} from "@/lib/sessions/manager";

afterEach(() => resetFileLocksForTests());

function manager(options: ConstructorParameters<typeof SessionManager>[0] = {}) {
  let now = 1_000;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const cancelled: string[] = [];
  const live = new Set<string>();
  const m = new SessionManager({
    now: clock.now,
    cancelRun: (runId) => {
      cancelled.push(runId);
      return live.delete(runId);
    },
    isRunLive: (runId) => live.has(runId),
    ...options,
  });
  return { m, clock, cancelled, live };
}

function collector() {
  const events: OrchestrationEvent[] = [];
  return { events, emit: (e: OrchestrationEvent) => events.push(e) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("session lifecycle", () => {
  it("creates, lists, renames, switches model and deletes", async () => {
    const { m } = manager();
    const a = await m.create({ repoKey: "repo", model: "claude-x", conversationId: "c1" });
    const b = await m.create({ repoKey: "repo", title: "  Refactor   auth  " });
    await m.create({ repoKey: "other" });

    expect(a).toMatchObject({ title: "Session 1", status: "idle", model: "claude-x", mode: "shared", conversationId: "c1" });
    expect(b.title).toBe("Refactor auth");
    expect(m.list("repo").map((s) => s.id)).toEqual([a.id, b.id]);
    expect(m.list("other")).toHaveLength(1);

    const renamed = m.update(a.id, { title: "x".repeat(200), model: "gpt", conversationId: "c2" });
    expect(renamed.title).toHaveLength(80);
    expect(renamed).toMatchObject({ model: "gpt", conversationId: "c2" });
    // Blank titles keep the old one.
    expect(m.update(a.id, { title: "   " }).title).toHaveLength(80);

    expect(await m.delete(a.id)).toBe(true);
    expect(await m.delete(a.id)).toBe(false);
    expect(m.get(a.id)).toBeUndefined();
    expect(() => m.update(a.id, { title: "y" })).toThrow(SessionError);
  });

  it("rejects a missing repo key and unknown sessions with status codes", async () => {
    const { m } = manager();
    await expect(m.create({ repoKey: "" })).rejects.toMatchObject({ status: 400 });
    expect(() => m.beginRun("nope", "r")).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("tracks a run: queued → running → awaiting-approval → running → done, with the ledger", async () => {
    const { m } = manager();
    const s = await m.create({ repoKey: "repo" });
    m.beginRun(s.id, "run-1");
    expect(m.get(s.id)?.status).toBe("queued");
    const log = collector();
    expect(await m.acquireSlot(s.id, { emit: log.emit })).toBe(true);
    expect(log.events).toEqual([{ type: "session", sessionId: s.id, status: "running" }]);
    expect(m.get(s.id)?.status).toBe("running");

    m.observe(s.id, { type: "approval_request", approvalId: "ap1", agentId: "a", kind: "command", title: "rm", command: "rm", reason: "r" });
    expect(m.get(s.id)).toMatchObject({ status: "awaiting-approval", pendingApprovals: 1 });
    m.observe(s.id, { type: "approval_resolved", approvalId: "ap1", decision: "allow" });
    expect(m.get(s.id)).toMatchObject({ status: "running", pendingApprovals: 0 });

    const ledger = { type: "ledger", ledger: {} as never, tokensIn: 100, tokensOut: 20, tokensCached: 5, costUsd: 0.5, uncachedUsd: 1 } as const;
    m.observe(s.id, ledger);
    m.observe(s.id, { ...ledger, tokensIn: 150, tokensOut: 30 });
    expect(m.get(s.id)?.ledger).toEqual({ runs: 1, tokensIn: 150, tokensOut: 30, tokensCached: 5, costUsd: 0.5 });

    m.finishRun(s.id, "done");
    expect(m.get(s.id)).toMatchObject({ status: "done", runId: null });

    // A second run adds to the ledger rather than replacing it.
    m.beginRun(s.id, "run-2");
    await m.acquireSlot(s.id);
    m.observe(s.id, { ...ledger, tokensIn: 10, tokensOut: 1, tokensCached: 0, costUsd: 0.25 });
    m.finishRun(s.id, "failed", "boom");
    expect(m.get(s.id)).toMatchObject({
      status: "error",
      error: "boom",
      ledger: { runs: 2, tokensIn: 160, tokensOut: 31, tokensCached: 5, costUsd: 0.75 },
    });
  });

  it("maps run outcomes to session statuses", () => {
    expect(statusForRun("done")).toBe("done");
    expect(statusForRun("incomplete")).toBe("done");
    expect(statusForRun("failed")).toBe("error");
    expect(statusForRun("error")).toBe("error");
    expect(statusForRun("cancelled")).toBe("idle");
  });

  it("refuses a second run in a busy session with 409", async () => {
    const { m } = manager();
    const s = await m.create({ repoKey: "repo", title: "Busy" });
    m.beginRun(s.id, "r1");
    expect(() => m.beginRun(s.id, "r2")).toThrow(/already running/);
    try {
      m.beginRun(s.id, "r2");
    } catch (error) {
      expect((error as SessionError).status).toBe(409);
    }
  });

  it("deleting a running session cancels its run and releases its file locks", async () => {
    const { m, cancelled, live } = manager();
    const s = await m.create({ repoKey: "repo" });
    live.add("r1");
    m.beginRun(s.id, "r1");
    await m.acquireSlot(s.id);
    claimFile("store:repo", "a.ts", { ownerId: s.id, label: "S" });
    expect(await m.delete(s.id)).toBe(true);
    expect(cancelled).toEqual(["r1"]);
    expect(listLocks()).toEqual([]);
    expect(m.load("repo")).toEqual({ running: 0, queued: 0 });
  });

  it("lists the files a session holds locked", async () => {
    const { m } = manager();
    const s = await m.create({ repoKey: "repo" });
    claimFile("store:repo", "b.ts", { ownerId: s.id, label: "S" });
    claimFile("store:repo", "a.ts", { ownerId: s.id, label: "S" });
    claimFile("store:repo", "c.ts", { ownerId: "someone-else", label: "T" });
    expect(m.get(s.id)?.lockedFiles).toEqual(["a.ts", "b.ts"]);
    m.finishRun(s.id, "done");
    expect(m.get(s.id)?.lockedFiles).toEqual([]);
  });
});

describe("event stream separation and replay", () => {
  it("each session replays only its own run's events, then the live tail", async () => {
    const { m } = manager();
    const a = await m.create({ repoKey: "repo" });
    const b = await m.create({ repoKey: "repo" });
    m.beginRun(a.id, "ra");
    m.beginRun(b.id, "rb");
    m.observe(a.id, { type: "answer", text: "from A" });
    m.observe(b.id, { type: "answer", text: "from B" });

    const seenA: OrchestrationEvent[] = [];
    let endedA = false;
    const unsubscribe = m.subscribe(a.id, (e) => seenA.push(e), () => {
      endedA = true;
    });
    m.observe(a.id, { type: "answer", text: "A live" });
    m.observe(b.id, { type: "answer", text: "B live" });
    expect(seenA).toEqual([
      { type: "answer", text: "from A" },
      { type: "answer", text: "A live" },
    ]);
    expect(endedA).toBe(false);
    m.finishRun(a.id, "done");
    expect(endedA).toBe(true);
    unsubscribe();

    // A finished run replays in full and ends at once.
    const replay: OrchestrationEvent[] = [];
    let ended = false;
    m.subscribe(a.id, (e) => replay.push(e), () => {
      ended = true;
    });
    expect(replay).toHaveLength(2);
    expect(ended).toBe(true);

    // A new run starts a fresh buffer.
    m.beginRun(a.id, "ra2");
    const fresh: OrchestrationEvent[] = [];
    m.subscribe(a.id, (e) => fresh.push(e), () => {});
    expect(fresh).toEqual([]);
  });
});

describe("concurrency limit and queue", () => {
  it("queues runs beyond the limit and starts them FIFO as slots free", async () => {
    const { m } = manager({ config: { maxConcurrent: 2 } });
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => m.create({ repoKey: "repo" })));
    for (const s of [a, b, c, d]) m.beginRun(s.id, `run-${s.id}`);
    const logs = { c: collector(), d: collector() };

    expect(await m.acquireSlot(a.id)).toBe(true);
    expect(await m.acquireSlot(b.id)).toBe(true);
    const started: string[] = [];
    const pc = m.acquireSlot(c.id, { emit: logs.c.emit }).then((ok) => ok && started.push("c"));
    const pd = m.acquireSlot(d.id, { emit: logs.d.emit }).then((ok) => ok && started.push("d"));
    await flush();

    expect(started).toEqual([]);
    expect(m.load("repo")).toEqual({ running: 2, queued: 2 });
    expect(logs.c.events.at(-1)).toMatchObject({ type: "session", status: "queued", position: 1 });
    expect(logs.d.events.at(-1)).toMatchObject({ type: "session", status: "queued", position: 2 });
    expect(m.get(d.id)).toMatchObject({ status: "queued", queuePosition: 2 });

    m.finishRun(a.id, "done");
    await pc;
    expect(started).toEqual(["c"]);
    expect(logs.c.events.at(-1)).toMatchObject({ type: "session", status: "running" });
    // d moved up.
    expect(logs.d.events.at(-1)).toMatchObject({ status: "queued", position: 1 });

    m.finishRun(b.id, "done");
    await pd;
    expect(started).toEqual(["c", "d"]);
    expect(m.load("repo")).toEqual({ running: 2, queued: 0 });
  });

  it("limits are per workspace", async () => {
    const { m } = manager({ config: { maxConcurrent: 1 } });
    const a = await m.create({ repoKey: "one" });
    const b = await m.create({ repoKey: "two" });
    m.beginRun(a.id, "ra");
    m.beginRun(b.id, "rb");
    expect(await m.acquireSlot(a.id)).toBe(true);
    expect(await m.acquireSlot(b.id)).toBe(true);
  });

  it("a cancelled or aborted queued run leaves the queue and resolves false", async () => {
    const { m } = manager({ config: { maxConcurrent: 1 } });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => m.create({ repoKey: "repo" })));
    for (const s of [a, b, c]) m.beginRun(s.id, `run-${s.id}`);
    await m.acquireSlot(a.id);
    const pb = m.acquireSlot(b.id);
    const controller = new AbortController();
    const pc = m.acquireSlot(c.id, { signal: controller.signal });

    expect(m.cancel(b.id)).toBe(true);
    expect(await pb).toBe(false);
    expect(m.get(b.id)?.status).toBe("idle");
    expect(m.get(c.id)?.queuePosition).toBe(1);

    controller.abort();
    expect(await pc).toBe(false);
    expect(m.load("repo")).toEqual({ running: 1, queued: 0 });

    // An already-aborted signal never queues.
    expect(await m.acquireSlot(c.id, { signal: controller.signal })).toBe(false);
  });

  it("raising the limit starts queued runs immediately", async () => {
    const { m } = manager({ config: { maxConcurrent: 1 } });
    const [a, b] = await Promise.all([1, 2].map(() => m.create({ repoKey: "repo" })));
    m.beginRun(a.id, "ra");
    m.beginRun(b.id, "rb");
    await m.acquireSlot(a.id);
    const pb = m.acquireSlot(b.id);
    expect(m.configure({ maxConcurrent: 2 }).maxConcurrent).toBe(2);
    expect(await pb).toBe(true);
  });

  it("an exclusive (fix) run waits for other shared runs and blocks them; isolated runs are unaffected", async () => {
    const worktrees: WorktreeDeps = {
      rootFor: async () => "/repo",
      create: async (_root, name) => `/tmp/${name}`,
      register: async (dir) => `wt:${dir}`,
      remove: async () => true,
    };
    const { m } = manager({ config: { maxConcurrent: 5 }, worktrees });
    const shared1 = await m.create({ repoKey: "repo" });
    const fix = await m.create({ repoKey: "repo" });
    const shared2 = await m.create({ repoKey: "repo" });
    const iso = await m.create({ repoKey: "repo", mode: "isolated" });
    for (const s of [shared1, fix, shared2, iso]) m.beginRun(s.id, `run-${s.id}`);

    expect(await m.acquireSlot(shared1.id)).toBe(true);
    let fixStarted = false;
    const pf = m.acquireSlot(fix.id, { exclusive: true }).then((ok) => (fixStarted = ok));
    await flush();
    expect(fixStarted).toBe(false);

    // FIFO: the later shared run waits behind the exclusive one.
    let shared2Started = false;
    const p2 = m.acquireSlot(shared2.id).then((ok) => (shared2Started = ok));
    await flush();
    expect(shared2Started).toBe(false);

    m.finishRun(shared1.id, "done");
    await pf;
    expect(fixStarted).toBe(true);
    await flush();
    expect(shared2Started).toBe(false);

    m.finishRun(fix.id, "done");
    await p2;
    expect(shared2Started).toBe(true);

    // Isolated sessions only count toward the limit.
    const exclusiveIso = await m.acquireSlot(iso.id, { exclusive: true });
    expect(exclusiveIso).toBe(true);
  });

  it("normalizes config", () => {
    expect(normalizeConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(normalizeConfig({ maxConcurrent: 99 }).maxConcurrent).toBe(12);
    expect(normalizeConfig({ maxConcurrent: 2.6 }).maxConcurrent).toBe(3);
    expect(normalizeConfig({ idleTtlMs: 5 }).idleTtlMs).toBe(60_000);
    expect(normalizeConfig({}, { maxConcurrent: 4, idleTtlMs: 120_000 })).toEqual({ maxConcurrent: 4, idleTtlMs: 120_000 });
  });
});

describe("cleanup", () => {
  it("sweeps idle sessions past the TTL and keeps active and recently used ones", async () => {
    const { m, clock, live } = manager({ config: { idleTtlMs: 60_000 } });
    const stale = await m.create({ repoKey: "repo" });
    const busy = await m.create({ repoKey: "repo" });
    const touched = await m.create({ repoKey: "repo" });
    live.add("busy-run");
    m.beginRun(busy.id, "busy-run");
    await m.acquireSlot(busy.id);

    clock.advance(59_000);
    m.touch(touched.id);
    clock.advance(2_000);
    expect(await m.sweep()).toEqual([stale.id]);
    expect(m.list("repo").map((s) => s.id)).toEqual([busy.id, touched.id]);
  });

  it("marks a session whose run vanished as errored and frees its slot and locks", async () => {
    const { m, clock } = manager({ config: { maxConcurrent: 1, idleTtlMs: 60_000 } });
    const s = await m.create({ repoKey: "repo" });
    m.beginRun(s.id, "ghost");
    await m.acquireSlot(s.id);
    claimFile("store:repo", "x.ts", { ownerId: s.id, label: "S" });

    await m.sweep();
    expect(m.get(s.id)).toMatchObject({ status: "error", error: "The run was interrupted." });
    expect(listLocks()).toEqual([]);
    expect(m.load("repo").running).toBe(0);

    clock.advance(61_000);
    expect(await m.sweep()).toEqual([s.id]);
  });

  it("removes an isolated session's worktree on delete, and on sweep", async () => {
    const removed: string[] = [];
    const worktrees: WorktreeDeps = {
      rootFor: async () => "/repo",
      create: async (_root, name) => `/tmp/${name}`,
      register: async (dir) => `wt:${dir}`,
      remove: async (_root, dir) => {
        removed.push(dir);
        return true;
      },
    };
    const { m, clock } = manager({ worktrees, config: { idleTtlMs: 60_000 } });
    const a = await m.create({ repoKey: "repo", mode: "isolated" });
    const b = await m.create({ repoKey: "repo", mode: "isolated" });
    expect(a.worktree).toEqual({ path: `/tmp/session-${a.id}`, repoKey: `wt:/tmp/session-${a.id}` });
    expect(m.worktreeOf(a.id)?.repoRoot).toBe("/repo");
    await m.delete(a.id);
    clock.advance(61_000);
    await m.sweep();
    expect(removed).toEqual([`/tmp/session-${a.id}`, `/tmp/session-${b.id}`]);
  });

  it("isolated mode fails cleanly without a disk workspace or when git refuses", async () => {
    const noDisk = manager({
      worktrees: {
        rootFor: async () => null,
        create: async () => "/x",
        register: async () => "k",
        remove: async () => true,
      },
    }).m;
    await expect(noDisk.create({ repoKey: "repo", mode: "isolated" })).rejects.toMatchObject({ status: 400 });
    expect(noDisk.list("repo")).toEqual([]);

    const removed: string[] = [];
    const registerFails = manager({
      worktrees: {
        rootFor: async () => "/repo",
        create: async () => "/tmp/wt",
        register: async () => {
          throw new Error("scan failed");
        },
        remove: async (_r, dir) => {
          removed.push(dir);
          return true;
        },
      },
    }).m;
    await expect(registerFails.create({ repoKey: "repo", mode: "isolated" })).rejects.toThrow("scan failed");
    expect(removed).toEqual(["/tmp/wt"]);

    const none = manager().m;
    await expect(none.create({ repoKey: "repo", mode: "isolated" })).rejects.toThrow(/not available/);
  });
});
