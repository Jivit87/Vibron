/**
 * The session API and POST /api/agent with sessions, end to end through the
 * real route handlers, run registry, file locks, checkpoints and session
 * manager. Only the orchestrator is replaced: a scripted agent that writes a
 * file through the real tool layer and can be held open to test queueing.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { OrchestrationInput } from "@/lib/agents/orchestrator";

const gates = new Map<string, () => void>();
const started: string[] = [];

vi.mock("@/lib/agents/orchestrator", () => ({
  /** Request grammar: `<label> write:<path> [hold]`. */
  orchestrate: vi.fn(async (input: OrchestrationInput) => {
    const { runTool } = await import("@/lib/tools/registry");
    const label = input.request.split(" ")[0];
    started.push(label);
    input.emit({ type: "run_start", runId: input.runId!, mode: "single", model: "m", at: Date.now() });
    input.emit({ type: "answer", text: `hello from ${label}` });
    const path = input.request.match(/write:(\S+)/)?.[1];
    if (path) {
      const out = await runTool(
        "write_file",
        { path, content: `// by ${label}\nexport function f() { return "${label}"; }\n`, summary: "w" },
        {
          handle: input.handle,
          engine: {} as never,
          memory: {} as never,
          agent: label,
          commandPolicy: "never",
          runId: input.runId,
          events: {
            onFileChange: (c) =>
              input.emit({
                type: "file_change",
                agentId: label,
                kind: c.kind,
                path: c.path,
                before: c.before,
                after: c.after,
                summary: c.summary,
                adds: 1,
                removes: 0,
              }),
          },
        },
      );
      input.emit({ type: "answer", text: ` [tool] ${out}` });
    }
    if (input.request.includes("hold")) {
      await new Promise<void>((resolve) => {
        gates.set(label, resolve);
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    input.emit({
      type: "ledger",
      ledger: {} as never,
      tokensIn: 10,
      tokensOut: 5,
      tokensCached: 0,
      costUsd: 0.01,
      uncachedUsd: 0.01,
    });
    input.emit({ type: "run_done", status: "done", summary: "ok", filesChanged: path ? 1 : 0, durationMs: 1, costUsd: 0.01 });
  }),
}));

const { POST: agentPost } = await import("@/app/api/agent/route");
const sessionsRoute = await import("@/app/api/sessions/route");
const sessionRoute = await import("@/app/api/sessions/[id]/route");
const cancelRoute = await import("@/app/api/sessions/[id]/cancel/route");
const undoRoute = await import("@/app/api/sessions/[id]/undo/route");
const eventsRoute = await import("@/app/api/sessions/[id]/events/route");
const applyRoute = await import("@/app/api/sessions/[id]/apply/route");
const { getSessionManager } = await import("@/lib/sessions");
const { resetRunsForTests } = await import("@/lib/harness/runs");
const { resetFileLocksForTests } = await import("@/lib/sessions/file-locks");
const { readFile } = await import("@/lib/workspace");
const { makeWorkspace } = await import("./helpers/harness-workspace");
const { makeTmpRepo } = await import("./helpers/tmp-repo");
const { registerLocalWorkspace } = await import("@/lib/local-disk-workspace");
type TmpRepo = import("./helpers/tmp-repo").TmpRepo;

type Workspace = Awaited<ReturnType<typeof makeWorkspace>>;
let ws: Workspace;
const repoKey = "harness-test";

beforeEach(async () => {
  ws = await makeWorkspace([
    { path: "src/a.ts", source: "export function a() { return 1; }\n" },
    { path: "src/b.ts", source: "export function b() { return 2; }\n" },
  ]);
  gates.clear();
  started.length = 0;
});

afterEach(async () => {
  for (const release of gates.values()) release();
  const manager = await getSessionManager();
  manager.reset();
  manager.configure({ maxConcurrent: 3 });
  resetRunsForTests();
  resetFileLocksForTests();
});

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function createSession(body: Record<string, unknown> = {}) {
  const res = await sessionsRoute.POST(new Request("http://x/api/sessions", json({ repoKey, ...body })));
  expect(res.status).toBe(201);
  return ((await res.json()) as { session: { id: string; title: string } }).session;
}

function parseSse(text: string): OrchestrationEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    .filter(Boolean)
    .map((payload) => JSON.parse(payload) as OrchestrationEvent);
}

async function run(sessionId: string | undefined, prompt: string) {
  const res = await agentPost(
    new Request("http://x/api/agent", json({ repoKey, prompt, sessionId, interaction: "agent", mode: "single" })),
  );
  return { res, events: res.ok ? res.text().then(parseSse) : Promise.resolve([] as OrchestrationEvent[]) };
}

const answers = (events: OrchestrationEvent[]) =>
  events.filter((e): e is Extract<OrchestrationEvent, { type: "answer" }> => e.type === "answer").map((e) => e.text).join("");

describe("session API", () => {
  it("creates, lists, renames, cancels and deletes sessions", async () => {
    const a = await createSession({ title: "Alpha", model: "m1", conversationId: "c1" });
    await createSession();

    const list = await sessionsRoute.GET(new Request(`http://x/api/sessions?repoKey=${repoKey}`));
    const body = (await list.json()) as { sessions: { id: string; title: string }[]; config: { maxConcurrent: number }; running: number };
    expect(body.sessions.map((s) => s.title)).toEqual(["Alpha", "Session 2"]);
    expect(body.config.maxConcurrent).toBe(3);
    expect(body.running).toBe(0);

    const patched = await sessionRoute.PATCH(new Request("http://x", json({ title: "Renamed" }, "PATCH")), ctx(a.id));
    expect(((await patched.json()) as { session: { title: string } }).session.title).toBe("Renamed");
    const got = await sessionRoute.GET(new Request("http://x"), ctx(a.id));
    expect(((await got.json()) as { session: { conversationId: string } }).session.conversationId).toBe("c1");

    const cancelled = await cancelRoute.POST(new Request("http://x", { method: "POST" }), ctx(a.id));
    expect(await cancelled.json()).toEqual({ ok: false });

    expect((await sessionRoute.DELETE(new Request("http://x"), ctx(a.id))).status).toBe(200);
    expect((await sessionRoute.DELETE(new Request("http://x"), ctx(a.id))).status).toBe(404);
    expect((await sessionRoute.GET(new Request("http://x"), ctx(a.id))).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await sessionsRoute.GET(new Request("http://x/api/sessions"))).status).toBe(400);
    expect((await sessionsRoute.POST(new Request("http://x", json({})))).status).toBe(400);
    expect((await sessionsRoute.POST(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await sessionsRoute.PUT(new Request("http://x", json({ maxConcurrent: "lots" }, "PUT")))).status).toBe(400);
    const put = await sessionsRoute.PUT(new Request("http://x", json({ maxConcurrent: 40 }, "PUT")));
    expect(((await put.json()) as { config: { maxConcurrent: number } }).config.maxConcurrent).toBe(12);
    // A store workspace cannot host an isolated session.
    const iso = await sessionsRoute.POST(new Request("http://x", json({ repoKey, mode: "isolated" })));
    expect(iso.status).toBe(400);
    expect(((await iso.json()) as { error: string }).error).toMatch(/on disk/);
    // Apply is only for isolated sessions.
    const shared = await createSession();
    expect((await applyRoute.GET(new Request("http://x"), ctx(shared.id))).status).toBe(400);
    expect((await applyRoute.POST(new Request("http://x", { method: "POST" }), ctx("nope"))).status).toBe(404);
  });
});

describe("POST /api/agent with sessions", () => {
  it("refuses unknown sessions and sessions of another workspace", async () => {
    expect((await run("ses_missing", "x")).res.status).toBe(404);
    const other = await (await getSessionManager()).create({ repoKey: "other-repo" });
    expect((await run(other.id, "x")).res.status).toBe(404);
  });

  it("runs two sessions concurrently on disjoint files with separate streams and ledgers", async () => {
    const a = await createSession({ title: "Alpha" });
    const b = await createSession({ title: "Beta" });
    const [ra, rb] = await Promise.all([run(a.id, "A write:src/a.ts"), run(b.id, "B write:src/b.ts")]);
    const [ea, eb] = await Promise.all([ra.events, rb.events]);

    expect(answers(ea)).toContain("hello from A");
    expect(answers(ea)).not.toContain("from B");
    expect(answers(eb)).toContain("hello from B");
    expect(answers(eb)).not.toContain("from A");
    expect(ea.filter((e) => e.type === "session")).toEqual([{ type: "session", sessionId: a.id, status: "running" }]);
    expect(ea.find((e) => e.type === "checkpoint")).toBeTruthy();

    expect(await readFile(ws.handle, "src/a.ts")).toContain("by A");
    expect(await readFile(ws.handle, "src/b.ts")).toContain("by B");

    const manager = await getSessionManager();
    expect(manager.get(a.id)).toMatchObject({ status: "done", runId: null, lockedFiles: [], ledger: { runs: 1, tokensIn: 10, costUsd: 0.01 } });
    expect(manager.get(b.id)?.checkpointIds).toHaveLength(1);

    // Replay after the fact: A's buffer holds A's run only.
    const replay = parseSse(await (await eventsRoute.GET(new Request("http://x"), ctx(a.id))).text());
    expect(answers(replay)).toContain("hello from A");
    expect(answers(replay)).not.toContain("from B");

    // Undoing A reverts A's file and leaves B's.
    const undo = await undoRoute.POST(new Request("http://x", { method: "POST" }), ctx(a.id));
    expect(await undo.json()).toMatchObject({ restored: 1, deleted: 0, conflicts: [] });
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export function a() { return 1; }\n");
    expect(await readFile(ws.handle, "src/b.ts")).toContain("by B");
  });

  it("the second session writing a held file gets a tool error naming the holder", async () => {
    const a = await createSession({ title: "Alpha" });
    const b = await createSession({ title: "Beta" });
    const ra = await run(a.id, "A write:src/a.ts hold");
    await vi.waitFor(() => expect(gates.has("A")).toBe(true));
    expect((await getSessionManager()).get(a.id)?.lockedFiles).toEqual(["src/a.ts"]);

    const eb = await (await run(b.id, "B write:src/a.ts")).events;
    expect(answers(eb)).toContain(`Refused: src/a.ts is locked by another session, "Alpha" (${a.id})`);
    expect(await readFile(ws.handle, "src/a.ts")).toContain("by A");

    gates.get("A")!();
    await ra.events;
    // Released with the run: B may write it now.
    const again = await (await run(b.id, "B write:src/a.ts")).events;
    expect(answers(again)).toMatch(/Updated src\/a\.ts/);
  });

  it("queues runs beyond the limit and starts them when a slot frees", async () => {
    (await getSessionManager()).configure({ maxConcurrent: 1 });
    const a = await createSession({ title: "Alpha" });
    const b = await createSession({ title: "Beta" });
    const ra = await run(a.id, "A hold");
    await vi.waitFor(() => expect(gates.has("A")).toBe(true));

    const rb = await run(b.id, "B");
    await vi.waitFor(async () => expect((await getSessionManager()).get(b.id)?.status).toBe("queued"));
    expect(started).toEqual(["A"]);
    const list = (await (await sessionsRoute.GET(new Request(`http://x/api/sessions?repoKey=${repoKey}`))).json()) as { running: number; queued: number };
    expect(list).toMatchObject({ running: 1, queued: 1 });

    gates.get("A")!();
    const [, eb] = await Promise.all([ra.events, rb.events]);
    expect(started).toEqual(["A", "B"]);
    const sessionEvents = eb.filter((e) => e.type === "session");
    expect(sessionEvents[0]).toMatchObject({ status: "queued", position: 1 });
    expect(sessionEvents.at(-1)).toMatchObject({ status: "running" });
  });

  it("cancelling a queued session ends its stream without running it", async () => {
    (await getSessionManager()).configure({ maxConcurrent: 1 });
    const a = await createSession();
    const b = await createSession();
    const ra = await run(a.id, "A hold");
    await vi.waitFor(() => expect(gates.has("A")).toBe(true));
    const rb = await run(b.id, "B");
    await vi.waitFor(async () => expect((await getSessionManager()).get(b.id)?.status).toBe("queued"));

    expect(await (await cancelRoute.POST(new Request("http://x", { method: "POST" }), ctx(b.id))).json()).toEqual({ ok: true });
    const eb = await rb.events;
    expect(eb.at(-1)).toMatchObject({ type: "run_done", status: "cancelled" });
    expect(started).toEqual(["A"]);
    expect((await getSessionManager()).get(b.id)?.status).toBe("idle");
    gates.get("A")!();
    await ra.events;
  });

  it("a busy session refuses a second run with 409", async () => {
    const a = await createSession({ title: "Alpha" });
    const ra = await run(a.id, "A hold");
    await vi.waitFor(() => expect(gates.has("A")).toBe(true));
    const second = await run(a.id, "A2");
    expect(second.res.status).toBe(409);
    expect(((await second.res.json()) as { error: string }).error).toMatch(/already running/);
    gates.get("A")!();
    await ra.events;
  });

  it("a sessionless run still works and still takes file locks", async () => {
    const plain = await run(undefined, "P write:src/b.ts");
    expect(answers(await plain.events)).toMatch(/Updated src\/b\.ts/);
  });
});

describe("isolated sessions (git worktree)", () => {
  let repo: TmpRepo;
  let mainKey: string;

  beforeEach(async () => {
    repo = makeTmpRepo({ "src/app.ts": "export function app() { return 1; }\n", "README.md": "# r\n" });
    mainKey = (await registerLocalWorkspace(repo.root)).repoKey;
  });
  afterEach(() => repo.cleanup());

  it("runs in its own worktree, leaves the checkout alone until applied, and cleans up on close", async () => {
    const res = await sessionsRoute.POST(new Request("http://x", json({ repoKey: mainKey, mode: "isolated", title: "Iso" })));
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; mode: string; worktree: { path: string } } };
    expect(session.mode).toBe("isolated");
    const dir = session.worktree.path;
    expect(existsSync(path.join(dir, "src/app.ts"))).toBe(true);

    const agent = await agentPost(
      new Request("http://x/api/agent", json({ repoKey: mainKey, prompt: "I write:src/app.ts", sessionId: session.id, mode: "single" })),
    );
    const events = parseSse(await agent.text());
    expect(answers(events)).toMatch(/Updated src\/app\.ts/);
    expect(readFileSync(path.join(dir, "src/app.ts"), "utf8")).toContain("by I");
    expect(repo.read("src/app.ts")).toBe("export function app() { return 1; }\n");

    const preview = (await (await applyRoute.GET(new Request("http://x"), ctx(session.id))).json()) as {
      files: { path: string; status: string }[];
      patch: string;
    };
    expect(preview.files).toEqual([{ status: "M", path: "src/app.ts" }]);
    expect(preview.patch).toContain("+// by I");

    // A shared session holding the file blocks the apply.
    const holder = (await getSessionManager()).get((await createSessionIn(mainKey)).id)!;
    const { claimFile, lockScope } = await import("@/lib/sessions/file-locks");
    claimFile(lockScope({ repoKey: mainKey, rootPath: repo.root }), "src/app.ts", { ownerId: holder.id, label: "Holder" });
    const blocked = await applyRoute.POST(new Request("http://x", { method: "POST" }), ctx(session.id));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain('locked by session "Holder"');
    resetFileLocksForTests();

    const applied = await applyRoute.POST(new Request("http://x", { method: "POST" }), ctx(session.id));
    expect(await applied.json()).toMatchObject({ ok: true, files: [{ path: "src/app.ts" }] });
    expect(repo.read("src/app.ts")).toContain("by I");

    // Applying again no longer applies cleanly (the checkout already has it).
    expect((await applyRoute.POST(new Request("http://x", { method: "POST" }), ctx(session.id))).status).toBe(409);

    expect((await sessionRoute.DELETE(new Request("http://x"), ctx(session.id))).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(repo.git("worktree", "list")).not.toContain(dir);
  });
});

async function createSessionIn(key: string) {
  const res = await sessionsRoute.POST(new Request("http://x", json({ repoKey: key })));
  return ((await res.json()) as { session: { id: string } }).session;
}
