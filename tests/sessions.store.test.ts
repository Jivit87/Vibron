import { beforeEach, describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { SessionSummary } from "@/lib/sessions/types";
import { DEFAULT_SETTINGS, useViberon, WELCOME_TAB_PATH } from "@/store/viberon";

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    repoKey: "test-repo",
    title: id.toUpperCase(),
    status: "idle",
    model: "auto",
    mode: "shared",
    createdAt: 1,
    lastActiveAt: 1,
    conversationId: `conv-${id}`,
    runId: null,
    queuePosition: null,
    pendingApprovals: 0,
    ledger: { runs: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 },
    lockedFiles: [],
    checkpointIds: [],
    ...patch,
  };
}

beforeEach(() => {
  useViberon.setState({
    repoKey: "test-repo",
    tabs: [{ path: WELCOME_TAB_PATH, label: "Welcome" }, { path: "src/x.ts", label: "x.ts", source: "old" }],
    activeTabPath: WELCOME_TAB_PATH,
    messages: [],
    run: null,
    runHistory: [],
    streaming: false,
    conversationId: "conv-a",
    conversations: [],
    conversationRuns: [],
    sessions: [],
    activeSessionId: null,
    settings: DEFAULT_SETTINGS,
  });
  const store = useViberon.getState();
  store.setSessions([summary("a"), summary("b")]);
  store.bindActiveSession("a");
});

const state = () => useViberon.getState();
const session = (id: string) => state().sessions.find((s) => s.id === id)!;

function start(sessionId: string, prompt: string) {
  state().appendMessage("user", prompt, sessionId);
  state().startRun({ prompt, model: "m", mode: "single", sessionId });
  state().appendMessage("assistant", "", sessionId);
}

const answer = (text: string): OrchestrationEvent => ({ type: "answer", text });

describe("multi-session store", () => {
  it("binds the active session to the top-level fields and keeps others as slices", () => {
    expect(state().activeSessionId).toBe("a");
    expect(session("a").slice).toBeNull();
    expect(session("b").slice).toMatchObject({ conversationId: "conv-b", messages: [], streaming: false });
  });

  it("streams into a background session without touching the one on screen", () => {
    start("a", "task A");
    start("b", "task B");
    state().appendToLastAssistant("reply A", "a");
    state().appendToLastAssistant("reply B", "b");
    state().applyEvent({ type: "agent_start", agentId: "x", stepId: "x", role: "generalist", title: "t", model: "m", wave: 0 }, "b");

    expect(state().messages.map((m) => m.content)).toEqual(["task A", "reply A"]);
    expect(state().streaming).toBe(true);
    expect(session("b").slice?.messages.map((m) => m.content)).toEqual(["task B", "reply B"]);
    expect(session("b").slice?.run?.agents).toHaveLength(1);
    expect(state().run?.agents).toHaveLength(0);
    expect(session("b").status).toBe("running");
  });

  it("switching sessions never drops events: each keeps its own run and thread", () => {
    start("a", "task A");
    start("b", "task B");
    state().switchSession("b");
    // Events keep arriving for both, whichever is on screen.
    state().appendToLastAssistant("more A", "a");
    state().appendToLastAssistant("more B", "b");
    expect(state().activeSessionId).toBe("b");
    expect(state().messages.map((m) => m.content)).toEqual(["task B", "more B"]);
    expect(state().run?.prompt).toBe("task B");
    expect(session("a").slice?.messages.map((m) => m.content)).toEqual(["task A", "more A"]);
    expect(session("a").slice?.streaming).toBe(true);

    state().switchSession("a");
    expect(state().messages.map((m) => m.content)).toEqual(["task A", "more A"]);
    expect(state().conversationId).toBe("conv-a");
    expect(session("b").slice?.conversationId).toBe("conv-b");
  });

  it("flags a background session that needs approval or finished, and clears it on open", () => {
    start("b", "task B");
    state().applyEvent(
      { type: "approval_request", approvalId: "ap", agentId: "x", kind: "command", title: "rm", command: "rm", reason: "r" },
      "b",
    );
    expect(session("b")).toMatchObject({ status: "awaiting-approval", attention: "approval" });
    state().resolveApproval("ap", "allow", "b");
    state().applyEvent({ type: "approval_resolved", approvalId: "ap", decision: "allow" }, "b");
    expect(session("b").status).toBe("running");

    state().applyEvent({ type: "run_done", status: "done", summary: "ok", filesChanged: 0, durationMs: 1, costUsd: 0 }, "b");
    state().endRun("done", "b");
    expect(session("b")).toMatchObject({ status: "done", attention: "done" });
    expect(session("b").slice?.streaming).toBe(false);
    expect(session("b").slice?.conversationRuns).toHaveLength(1);

    state().switchSession("b");
    expect(session("b").attention).toBeNull();
  });

  it("shows queue position from session events and a failed background run as an error", () => {
    start("b", "task B");
    state().applyEvent({ type: "session", sessionId: "b", status: "queued", position: 2 }, "b");
    expect(session("b")).toMatchObject({ status: "queued", queuePosition: 2 });
    state().applyEvent({ type: "session", sessionId: "b", status: "running" }, "b");
    expect(session("b")).toMatchObject({ status: "running", queuePosition: null });
    state().endRun("failed", "b");
    expect(session("b")).toMatchObject({ status: "error", attention: "error" });
  });

  it("mirrors file changes into open tabs for shared sessions only", () => {
    const change: OrchestrationEvent = {
      type: "file_change",
      agentId: "x",
      kind: "update",
      path: "src/x.ts",
      before: "old",
      after: "new",
      summary: "s",
      adds: 1,
      removes: 1,
    };
    start("b", "t");
    state().applyEvent(change, "b");
    expect(state().tabs.find((t) => t.path === "src/x.ts")?.source).toBe("new");

    state().setSessions([summary("a"), summary("b"), summary("iso", { mode: "isolated" })]);
    start("iso", "t");
    state().applyEvent({ ...change, after: "worktree" } as OrchestrationEvent, "iso");
    expect(state().tabs.find((t) => t.path === "src/x.ts")?.source).toBe("new");
  });

  it("opening a thread another session owns switches to that session", () => {
    state().switchConversation("conv-b");
    expect(state().activeSessionId).toBe("b");
    expect(state().conversationId).toBe("conv-b");
  });

  it("adds and activates a session, and closing the active one falls back to another", () => {
    start("a", "task A");
    state().addSession(summary("c"), { activate: true });
    expect(state().activeSessionId).toBe("c");
    expect(state().messages).toEqual([]);
    expect(session("a").slice?.messages).toHaveLength(2);

    state().removeSession("c");
    expect(state().sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(state().activeSessionId).toBe("a");
    expect(state().messages.map((m) => m.content)).toEqual(["task A", ""]);

    state().removeSession("b");
    state().removeSession("a");
    expect(state()).toMatchObject({ sessions: [], activeSessionId: null, messages: [] });
  });

  it("reconciles with the server list: new sessions appear, gone idle ones leave, streaming ones stay", () => {
    start("b", "task B");
    state().setSessions([summary("a", { title: "Renamed", status: "done" }), summary("d")]);
    expect(state().sessions.map((s) => s.id)).toEqual(["a", "d", "b"]);
    expect(session("a").title).toBe("Renamed");
    // The active session is streaming? No: server status applies.
    expect(session("a").status).toBe("done");

    state().endRun("done", "b");
    state().setSessions([summary("a"), summary("d")]);
    expect(state().sessions.map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("ignores events for a session that was closed while its stream drained", () => {
    state().removeSession("b");
    const before = state();
    state().appendToLastAssistant("late", "b");
    state().applyEvent(answer("late"), "b");
    expect(state().messages).toEqual(before.messages);
    expect(state().sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("sessionStreaming reports active and background sessions", () => {
    start("b", "t");
    expect(state().sessionStreaming("b")).toBe(true);
    expect(state().sessionStreaming("a")).toBe(false);
    start("a", "t");
    expect(state().sessionStreaming("a")).toBe(true);
  });
});
