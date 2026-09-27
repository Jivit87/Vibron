import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionCheckpoint, getCheckpoint, journalFileChange, listCheckpoints, restoreCheckpoint } from "@/lib/checkpoints";
import { activeLockCount, withKeyedLock } from "@/lib/concurrency/keyed-mutex";
import { createRun, finishRun, resetRunsForTests } from "@/lib/harness/runs";
import { commitMemory, loadMemory, mergeMemory, recordEntry, snapshotMemory, upsertTask } from "@/lib/memory";
import {
  claimFile,
  listLocks,
  lockConflictMessage,
  lockHolder,
  lockScope,
  releaseOwner,
  resetFileLocksForTests,
} from "@/lib/sessions/file-locks";
import { SessionManager } from "@/lib/sessions/manager";
import { undoSession } from "@/lib/sessions/undo";
import { getGraph, getRawFiles } from "@/lib/store";
import { isToolFailure, runTool, type FileChangeEvent, type ToolContext } from "@/lib/tools/registry";
import { readFile, refreshMemory } from "@/lib/workspace";
import { makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

const FILES = [
  { path: "src/a.ts", source: "export const a = 1;\n" },
  { path: "src/b.ts", source: "export const b = 2;\n" },
  { path: "src/shared.ts", source: "export const shared = 0;\n" },
];

let ws: TestWorkspace;

beforeEach(async () => {
  ws = await makeWorkspace(FILES);
});
afterEach(() => {
  resetRunsForTests();
  resetFileLocksForTests();
});

/** A tool context for one session's run, as the agent route wires it. */
function sessionRun(sessionId: string, label: string, onFileChange?: (change: FileChangeEvent) => void) {
  const run = createRun(ws.handle.repoKey, () => {}, { sessionId, label });
  const ctx: ToolContext = {
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    agent: "Test",
    commandPolicy: "never",
    runId: run.runId,
    events: { onFileChange },
  };
  return { run, ctx };
}

const write = (ctx: ToolContext, path: string, content: string) =>
  runTool("write_file", { path, content, summary: `write ${path}` }, ctx);

describe("file lock table", () => {
  it("first claim wins; the owner may re-claim; release frees everything it held", () => {
    const scope = lockScope({ repoKey: "r", rootPath: null });
    expect(scope).toBe("store:r");
    expect(lockScope({ repoKey: "r", rootPath: "/tmp/x/../x" })).toBe("disk:/tmp/x");
    expect(claimFile(scope, "./src//a.ts", { ownerId: "A", label: "Alpha" })).toEqual({ ok: true });
    expect(claimFile(scope, "src/a.ts", { ownerId: "A", label: "Alpha" })).toEqual({ ok: true });
    const lost = claimFile(scope, "src/a.ts", { ownerId: "B", label: "Beta" });
    expect(lost.ok).toBe(false);
    expect(!lost.ok && lost.holder).toMatchObject({ ownerId: "A", label: "Alpha", path: "src/a.ts" });
    // Other scopes (an isolated worktree) do not contend.
    expect(claimFile("disk:/wt", "src/a.ts", { ownerId: "B", label: "Beta" })).toEqual({ ok: true });
    expect(releaseOwner("A")).toBe(1);
    expect(lockHolder(scope, "src/a.ts")).toBeUndefined();
    expect(listLocks()).toHaveLength(1);
  });

  it("the conflict message names the holding session and says not to retry", () => {
    const message = lockConflictMessage("./src/a.ts", {
      ownerId: "ses_1",
      label: "Refactor auth",
      scope: "s",
      path: "src/a.ts",
      since: 0,
    });
    expect(message).toMatch(/^Refused: src\/a\.ts is locked by another session, "Refactor auth" \(ses_1\)/);
    expect(message).toContain("Do not retry");
    expect(isToolFailure(message)).toBe(true);
  });
});

describe("cross-session write lock in the tools", () => {
  it("two sessions write disjoint files concurrently, and both land in files and graph", async () => {
    const a = sessionRun("ses_A", "Alpha");
    const b = sessionRun("ses_B", "Beta");
    const outputs = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => write(a.ctx, `src/alpha${i}.ts`, `export function alpha${i}() { return ${i}; }\n`)),
      ...Array.from({ length: 6 }, (_, i) => write(b.ctx, `src/beta${i}.ts`, `export function beta${i}() { return ${i}; }\n`)),
    ]);
    expect(outputs.every((o) => !isToolFailure(o))).toBe(true);

    // Store workspace: the raw-file list IS the content; no write may be lost.
    const raw = await getRawFiles(ws.handle.repoKey);
    for (let i = 0; i < 6; i += 1) {
      expect(raw.find((f) => f.path === `src/alpha${i}.ts`)?.source).toContain(`alpha${i}`);
      expect(raw.find((f) => f.path === `src/beta${i}.ts`)?.source).toContain(`beta${i}`);
    }
    const graph = await getGraph(ws.handle.repoKey);
    const files = new Set(graph?.nodes.map((n) => n.file));
    for (let i = 0; i < 6; i += 1) {
      expect(files.has(`src/alpha${i}.ts`)).toBe(true);
      expect(files.has(`src/beta${i}.ts`)).toBe(true);
    }
    expect(listLocks().filter((l) => l.ownerId === "ses_A")).toHaveLength(6);
  });

  it("the losing session gets a tool error naming the holder, and the file is untouched", async () => {
    const a = sessionRun("ses_A", "Alpha");
    const b = sessionRun("ses_B", "Beta");
    expect(await write(a.ctx, "src/shared.ts", "export const shared = 'A';\n")).toMatch(/^Updated/);

    for (const [tool, args] of [
      ["write_file", { path: "src/shared.ts", content: "B", summary: "s" }],
      ["edit_file", { path: "src/shared.ts", find: "'A'", replace: "'B'", summary: "s" }],
      ["multi_edit", { path: "src/shared.ts", edits: [{ old_str: "'A'", new_str: "'B'" }] }],
      ["append_file", { path: "src/shared.ts", content: "// B\n" }],
      ["delete_file", { path: "src/shared.ts", summary: "s" }],
      ["rename_file", { from: "src/shared.ts", to: "src/moved.ts", summary: "s" }],
    ] as const) {
      const out = await runTool(tool, args as Record<string, unknown>, b.ctx);
      expect(out, tool).toContain('locked by another session, "Alpha" (ses_A)');
      expect(isToolFailure(out)).toBe(true);
    }
    expect(await readFile(ws.handle, "src/shared.ts")).toBe("export const shared = 'A';\n");
    expect(await readFile(ws.handle, "src/moved.ts")).toBeNull();

    // A rename INTO a locked file is refused too, and claims nothing.
    await write(b.ctx, "src/b.ts", "export const b = 3;\n");
    expect(await runTool("rename_file", { from: "src/b.ts", to: "src/shared.ts", summary: "s" }, b.ctx)).toContain("Alpha");
    expect(await readFile(ws.handle, "src/b.ts")).toBe("export const b = 3;\n");

    // Parallel agents of the SAME session share its locks.
    const a2: ToolContext = { ...a.ctx, agent: "Other agent" };
    expect(await write(a2, "src/shared.ts", "export const shared = 'A2';\n")).toMatch(/^Updated/);

    // When A's run ends its locks go, and B may write.
    finishRun(a.run.runId);
    expect(await write(b.ctx, "src/shared.ts", "export const shared = 'B';\n")).toMatch(/^Updated/);
    expect(lockHolder(lockScope(ws.handle), "src/shared.ts")?.ownerId).toBe("ses_B");
  });

  it("runs without a session are lock owners too, labelled by run id", async () => {
    const plain = createRun(ws.handle.repoKey, () => {});
    const ctx: ToolContext = { handle: ws.handle, engine: ws.engine, memory: ws.memory, agent: "T", commandPolicy: "never", runId: plain.runId, events: {} };
    await write(ctx, "src/a.ts", "export const a = 9;\n");
    const b = sessionRun("ses_B", "Beta");
    expect(await write(b.ctx, "src/a.ts", "x")).toContain(`"run ${plain.runId.slice(0, 8)}"`);
    // A tool call outside any registered run is not lock-managed.
    const loose: ToolContext = { ...ctx, runId: undefined };
    expect(await write(loose, "src/a.ts", "export const a = 10;\n")).toMatch(/^Updated/);
  });
});

describe("per-session checkpoints and undo", () => {
  async function journaled(sessionId: string, label: string) {
    const checkpoint = await createSessionCheckpoint(ws.handle, sessionId, label);
    let chain: Promise<void> = Promise.resolve();
    const session = sessionRun(sessionId, label, (change) => {
      chain = chain.then(() => journalFileChange(checkpoint.id, change));
    });
    return { ...session, checkpoint, settle: () => chain };
  }

  it("undoing session A reverts only A's files; B's work survives", async () => {
    const m = new SessionManager();
    const sa = await m.create({ repoKey: ws.handle.repoKey, title: "Alpha" });
    const sb = await m.create({ repoKey: ws.handle.repoKey, title: "Beta" });
    const a = await journaled(sa.id, "Alpha");
    const b = await journaled(sb.id, "Beta");
    m.addCheckpoint(sa.id, a.checkpoint.id);
    m.addCheckpoint(sb.id, b.checkpoint.id);

    await Promise.all([
      write(a.ctx, "src/a.ts", "export const a = 'A1';\n"),
      write(b.ctx, "src/b.ts", "export const b = 'B1';\n"),
      write(a.ctx, "src/new-a.ts", "export const created = true;\n"),
    ]);
    await write(a.ctx, "src/a.ts", "export const a = 'A2';\n");
    await runTool("delete_file", { path: "src/shared.ts", summary: "gone" }, a.ctx);
    await Promise.all([a.settle(), b.settle()]);
    finishRun(a.run.runId);
    finishRun(b.run.runId);

    const stored = await getCheckpoint(a.checkpoint.id);
    expect(stored).toMatchObject({ scope: "session", sessionId: sa.id, created: ["src/new-a.ts"], fileCount: 3 });
    expect(stored?.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/shared.ts"]);
    expect((await listCheckpoints(ws.handle.repoKey, { sessionId: sa.id })).map((c) => c.id)).toEqual([a.checkpoint.id]);

    const result = await undoSession(m, sa.id);
    expect(result).toMatchObject({ restored: 2, deleted: 1, conflicts: [], checkpoints: [a.checkpoint.id] });
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await readFile(ws.handle, "src/shared.ts")).toBe("export const shared = 0;\n");
    expect(await readFile(ws.handle, "src/new-a.ts")).toBeNull();
    // B untouched.
    expect(await readFile(ws.handle, "src/b.ts")).toBe("export const b = 'B1';\n");

    // Undoing again is a no-op, not a wall of conflicts.
    expect(await undoSession(m, sa.id)).toMatchObject({ restored: 0, deleted: 0, conflicts: [] });
  });

  it("a file changed by someone else since is a conflict unless forced; a file locked by another session is never touched", async () => {
    const m = new SessionManager();
    const sa = await m.create({ repoKey: ws.handle.repoKey, title: "Alpha" });
    const a = await journaled(sa.id, "Alpha");
    m.addCheckpoint(sa.id, a.checkpoint.id);
    await write(a.ctx, "src/a.ts", "export const a = 'A';\n");
    await write(a.ctx, "src/b.ts", "export const b = 'A';\n");
    await a.settle();
    finishRun(a.run.runId);

    // The user edits a.ts afterwards; session B takes b.ts.
    const other = sessionRun("ses_B", "Beta");
    await runTool("edit_file", { path: "src/a.ts", find: "'A'", replace: "'user'", summary: "s" }, { ...other.ctx, runId: undefined });
    await write(other.ctx, "src/b.ts", "export const b = 'B';\n");

    const first = await undoSession(m, sa.id);
    expect(first.restored).toBe(0);
    expect(first.conflicts).toEqual([
      { path: "src/a.ts", reason: "changed since this session wrote it" },
      { path: "src/b.ts", reason: 'locked by session "Beta"' },
    ]);
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 'user';\n");

    const forced = await undoSession(m, sa.id, { force: true });
    expect(forced.restored).toBe(1);
    expect(forced.conflicts).toEqual([{ path: "src/b.ts", reason: 'locked by session "Beta"' }]);
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 1;\n");
    expect(await readFile(ws.handle, "src/b.ts")).toBe("export const b = 'B';\n");
  });

  it("refuses to undo a busy session, a foreign checkpoint, or an unknown session", async () => {
    const m = new SessionManager();
    const s = await m.create({ repoKey: ws.handle.repoKey });
    m.beginRun(s.id, "r");
    await expect(undoSession(m, s.id)).rejects.toMatchObject({ status: 409 });
    m.finishRun(s.id, "done");
    await expect(undoSession(m, s.id, { checkpointId: "cp_other" })).rejects.toMatchObject({ status: 404 });
    await expect(undoSession(m, "missing")).rejects.toMatchObject({ status: 404 });
    expect(await undoSession(m, s.id)).toEqual({ restored: 0, deleted: 0, conflicts: [], checkpoints: [] });
  });

  it("journals renames as delete-old plus create-new, and restore reverses both", async () => {
    const a = await journaled("ses_R", "Renamer");
    await runTool("rename_file", { from: "src/b.ts", to: "src/renamed.ts", summary: "mv" }, a.ctx);
    await a.settle();
    finishRun(a.run.runId);
    const restored = await restoreCheckpoint(ws.handle, a.checkpoint.id);
    expect(restored).toMatchObject({ restored: 1, deleted: 1, conflicts: [] });
    expect(await readFile(ws.handle, "src/b.ts")).toBe("export const b = 2;\n");
    expect(await readFile(ws.handle, "src/renamed.ts")).toBeNull();
  });
});

describe("shared memory with concurrent writers", () => {
  it("mergeMemory applies only one run's delta onto the fresh blob", () => {
    const base = snapshotMemory(ws.memory);
    const fresh = snapshotMemory(ws.memory);
    const local = snapshotMemory(ws.memory);
    recordEntry(fresh, "fact", { text: "written by B" });
    fresh.stats.turns += 1;
    recordEntry(local, "decision", { text: "written by A" });
    upsertTask(local, { title: "A's task" });
    local.overview = "A's overview";
    local.stats.turns += 1;
    local.stats.costUsd += 0.5;

    const merged = mergeMemory(fresh, base, local);
    expect(merged.facts.map((e) => e.text)).toContain("written by B");
    expect(merged.decisions.map((e) => e.text)).toContain("written by A");
    expect(merged.tasks.map((t) => t.title)).toContain("A's task");
    expect(merged.overview).toBe("A's overview");
    expect(merged.stats.turns).toBe(base.stats.turns + 2);
    expect(merged.stats.costUsd).toBeCloseTo(base.stats.costUsd + 0.5);
  });

  it("two sessions committing at once keep both sessions' entries", async () => {
    const baseA = snapshotMemory(ws.memory);
    const baseB = snapshotMemory(ws.memory);
    const localA = snapshotMemory(ws.memory);
    const localB = snapshotMemory(ws.memory);
    for (let i = 0; i < 5; i += 1) {
      recordEntry(localA, "fact", { text: `A fact ${i}` });
      recordEntry(localB, "fact", { text: `B fact ${i}` });
    }
    await Promise.all([commitMemory(baseA, localA), commitMemory(baseB, localB), refreshMemory(ws.handle)]);
    const stored = await loadMemory(ws.handle.repoKey);
    const texts = stored.facts.map((e) => e.text);
    for (let i = 0; i < 5; i += 1) {
      expect(texts).toContain(`A fact ${i}`);
      expect(texts).toContain(`B fact ${i}`);
    }
  });

  it("refreshMemory with a pending working copy keeps what the run recorded", async () => {
    const base = snapshotMemory(ws.memory);
    const local = snapshotMemory(ws.memory);
    recordEntry(local, "convention", { text: "use tabs" });
    const refreshed = await refreshMemory(ws.handle, { base, local });
    expect(refreshed.conventions.map((e) => e.text)).toContain("use tabs");
    expect((await loadMemory(ws.handle.repoKey)).conventions.map((e) => e.text)).toContain("use tabs");
  });
});

describe("keyed mutex", () => {
  it("serializes one key, runs different keys in parallel, survives throws, and drains", async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) =>
      withKeyedLock("t", "k", async () => {
        order.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${tag}:end`);
      });
    const failing = withKeyedLock("t", "k", async () => {
      throw new Error("boom");
    });
    const p = Promise.all([slow("a", 15), failing.catch(() => order.push("fail")), slow("b", 1)]);
    const other = withKeyedLock("t", "other", async () => order.push("other"));
    await Promise.all([p, other]);
    expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b:start"));
    expect(order.indexOf("other")).toBeLessThan(order.indexOf("a:end"));
    expect(order).toContain("fail");
    await new Promise((r) => setTimeout(r, 0));
    expect(activeLockCount()).toBe(0);
  });
});
