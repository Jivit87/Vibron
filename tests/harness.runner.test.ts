import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent, type AgentRunInput } from "@/lib/agents/runner";
import { readFile } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider, httpError } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

const FILES = [
  { path: "src/app.ts", source: "export function app() {\n  return 1;\n}\n" },
];

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace(FILES);
});
afterEach(() => uninstallFakeProvider());

function input(log: ReturnType<typeof eventLog>, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentId: "solo",
    stepId: "solo",
    role: "generalist",
    model: "claude-opus-5",
    task: "Change app to return 2.",
    files: [],
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    commandPolicy: "never",
    emit: log.emit,
    ...overrides,
  };
}

describe("runAgent tool loop", () => {
  it("runs tools, feeds results back, and pairs tool events by callId", async () => {
    const fake = installFakeProvider([
      {
        text: "Editing.",
        calls: [
          { id: "c1", name: "edit_file", input: { path: "src/app.ts", find: "return 1", replace: "return 2", summary: "bump" } },
        ],
      },
      { text: "Changed app to return 2." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log));

    expect(result.error).toBeUndefined();
    expect(result.summary).toBe("Changed app to return 2.");
    expect(result.filesTouched).toEqual(["src/app.ts"]);
    expect(await readFile(ws.handle, "src/app.ts")).toContain("return 2");

    const tools = log.of("agent_tool");
    expect(tools.map((t) => [t.callId, t.phase, t.ok])).toEqual([
      ["c1", "start", undefined],
      ["c1", "end", true],
    ]);
    expect(log.of("file_change")[0]).toMatchObject({ path: "src/app.ts", adds: 1, removes: 1 });

    // The second request carries the tool result for the first call.
    const second = fake.requests[1].messages;
    expect(second.at(-1)?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });

  it("answers malformed and disallowed calls with errors the model can learn from", async () => {
    installFakeProvider([
      {
        calls: [
          { id: "bad", name: "read_file", inputError: "Tool arguments were not valid JSON." },
          { id: "denied", name: "write_file", input: { path: "x.ts", content: "x", summary: "s" } },
        ],
      },
      { text: "Explained." },
    ]);
    const log = eventLog();
    await runAgent(input(log, { role: "assistant" }));
    const ends = log.of("agent_tool").filter((t) => t.phase === "end");
    expect(ends.map((e) => e.ok)).toEqual([false, false]);
    expect(ends[1].result).toContain("not available to this agent");
    expect(await readFile(ws.handle, "x.ts")).toBeNull();
  });

  it("emits agent_retry for transient provider failures and carries on", async () => {
    installFakeProvider([{ error: httpError(529, "overloaded") }, { text: "Done after retry." }]);
    const log = eventLog();
    const result = await runAgent(input(log));
    expect(result.summary).toBe("Done after retry.");
    expect(log.of("agent_retry")[0]).toMatchObject({ agentId: "solo", attempt: 1, maxAttempts: 4 });
  });

  it("emits todos with full-replace semantics", async () => {
    installFakeProvider([
      { calls: [{ name: "todo_write", input: { todos: [{ content: "a", status: "in_progress" }] } }] },
      { calls: [{ name: "todo_write", input: { todos: [{ content: "a", status: "completed" }] } }] },
      { text: "ok" },
    ]);
    const log = eventLog();
    await runAgent(input(log));
    expect(log.of("todos").map((t) => t.items[0].status)).toEqual(["in_progress", "completed"]);
  });

  it("puts project rules in the cached prefix and honours showThinking", async () => {
    const fake = installFakeProvider([{ thinking: "hmm", text: "ok" }]);
    const log = eventLog();
    await runAgent(input(log, { rules: "## Project rules\n\nUse tabs.", showThinking: false }));
    const system = fake.requests[0].system;
    const rulesIndex = system.findIndex((b) => b.text.includes("Use tabs."));
    const cacheIndex = system.findIndex((b) => b.cache);
    expect(rulesIndex).toBeGreaterThan(0);
    expect(rulesIndex).toBeLessThan(cacheIndex);
    expect(fake.requests[0].showThinking).toBe(false);
    expect(log.of("agent_thinking")).toHaveLength(0);
  });

  it("gives each agent its own dedupe ledger", async () => {
    const read = { calls: [{ name: "read_file", input: { path: "src/app.ts" } }] };
    const fake = installFakeProvider([read, { text: "a" }, read, { text: "b" }]);
    await runAgent(input(eventLog(), { agentId: "a" }));
    await runAgent(input(eventLog(), { agentId: "b" }));
    const resultFor = (i: number) =>
      (fake.requests[i].messages.at(-1)?.content[0] as { content: string }).content;
    expect(resultFor(1)).toContain("return 1");
    // Agent b never saw agent a's read, so it must get content, not a pointer.
    expect(resultFor(3)).toContain("return 1");
    expect(resultFor(3)).not.toContain("already in context");
  });

  it("stops promptly when cancelled mid-turn", async () => {
    installFakeProvider([{ hang: true }]);
    const controller = new AbortController();
    const log = eventLog();
    const pending = runAgent(input(log, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.error).toBe("cancelled");
    expect(log.of("agent_done")[0].error).toBe("cancelled");
  });

  it("compacts: elides old tool results once the context passes 60% of the window", async () => {
    // llama-3.1-8b-instant has a 128k window, so the limit is ~76.8k. Each
    // turn reports 76k in use; the fresh tool result tips it over.
    const turns = [
      ...Array.from({ length: 8 }, () => ({
        usage: { inputTokens: 76_000 },
        calls: [{ name: "read_file", input: { path: "src/app.ts" } }],
      })),
      { text: "done" },
    ];
    const fake = installFakeProvider(turns);
    const log = eventLog();
    // Distinct, sizeable results so each is worth eliding and none dedupes.
    let reads = 0;
    ws.engine.readFile = async () => `// read ${(reads += 1)}\n${"line of code\n".repeat(400)}`;
    await runAgent(input(log, { model: "llama-3.1-8b-instant" }));
    const compactions = log.of("compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.every((c) => c.strategy === "elide" && c.agentId === "solo")).toBe(true);
    // Only turns older than the last six lose their output.
    expect(fake.requests).toHaveLength(9);
    expect(compactions[0].afterTokens).toBeLessThan(compactions[0].beforeTokens);
    const last = fake.requests.at(-1)!.messages;
    const firstResult = last.find((m) => m.content.some((b) => b.type === "tool_result"));
    expect((firstResult!.content[0] as { content: string }).content).toMatch(/^\[elided:/);
  });
});
