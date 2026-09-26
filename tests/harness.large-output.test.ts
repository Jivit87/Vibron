/**
 * Large-output behaviour: output-cap truncation recovery, writing a file in
 * parts, atomic multi-edits, and pruning written payloads from the transcript.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgent, truncationHint, type AgentRunInput } from "@/lib/agents/runner";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import { getModel, outputCap } from "@/lib/ai/models";
import { openAiCompatTesting, openaiCompatProvider } from "@/lib/ai/openai-compat";
import { TRUNCATED_CALL_ERROR, type AiMessage, type AiTurnRequest } from "@/lib/ai/types";
import { elideOldToolResults, pruneTranscript } from "@/lib/harness/compact";
import { createEditSession } from "@/lib/tools/editor";
import { runTool, SOLVER_TOOLS, type FileChangeEvent, type ToolContext } from "@/lib/tools/registry";
import { readFile } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace([{ path: "src/app.ts", source: "export function app() {\n  return 1;\n}\n" }]);
});
afterEach(() => uninstallFakeProvider());

function input(log: ReturnType<typeof eventLog>, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentId: "solo",
    stepId: "solo",
    role: "generalist",
    model: "claude-opus-5",
    task: "Write the big module.",
    files: [],
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    commandPolicy: "never",
    mcp: false,
    emit: log.emit,
    ...overrides,
  };
}

/** `n` lines of valid TypeScript, numbered from `from`. */
function tsLines(from: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const v${from + i} = ${from + i};\n`).join("");
}

const cutWrite = (path = "src/big.ts") => ({
  name: "write_file",
  inputError: TRUNCATED_CALL_ERROR,
  partialInput: { path },
});

describe("output caps", () => {
  it("uses a large default for Claude and never exceeds the model ceiling", () => {
    const opus = getModel("claude-opus-5");
    expect(outputCap(opus)).toBe(64_000);
    expect(outputCap(opus, 500_000)).toBe(128_000);
    expect(outputCap(opus, 2048)).toBe(2048);
  });
});

describe("truncation recovery in the runner", () => {
  it("retries a turn cut off mid tool call once at the model ceiling, with the same transcript", async () => {
    const content = tsLines(0, 50);
    const fake = installFakeProvider([
      { calls: [cutWrite()], stopReason: "max_tokens" },
      (req: AiTurnRequest) => ({
        calls: req.maxTokens === 128_000 ? [{ name: "write_file", input: { path: "src/big.ts", content, summary: "big" } }] : [],
      }),
      { text: "Wrote the module." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log));

    expect(fake.requests[0].maxTokens).toBeUndefined();
    expect(fake.requests[1].maxTokens).toBe(128_000);
    expect(fake.requests[1].messages).toEqual(fake.requests[0].messages);
    expect(await readFile(ws.handle, "src/big.ts")).toBe(content);
    expect(result.metrics?.truncationRecoveries).toBe(1);
    expect(log.of("recovery")[0]).toMatchObject({ failureClass: "truncated", action: "hint" });
    // The cut-off call never reached a tool.
    expect(log.of("agent_tool").filter((t) => t.phase === "start")).toHaveLength(1);
  });

  it("drops a call still cut off at the ceiling, hints parts, and the parts land intact", async () => {
    const parts = [tsLines(0, 300), tsLines(300, 300), tsLines(600, 450)];
    const fake = installFakeProvider([
      { calls: [cutWrite()], stopReason: "max_tokens" },
      { text: "Writing it.", calls: [cutWrite()], stopReason: "max_tokens" },
      { calls: [{ name: "write_file", input: { path: "src/big.ts", content: parts[0], summary: "part 1" } }] },
      { calls: [{ name: "append_file", input: { path: "src/big.ts", content: parts[1] } }] },
      { calls: [{ name: "append_file", input: { path: "src/big.ts", content: parts[2] } }] },
      { text: "Done in three parts." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log));

    const onDisk = await readFile(ws.handle, "src/big.ts");
    expect(onDisk).toBe(parts.join(""));
    expect(onDisk?.split("\n").length).toBe(1051);
    expect(result.summary).toBe("Done in three parts.");
    expect(result.metrics?.truncationRecoveries).toBe(2);

    // The partial call is gone from the transcript; the hint takes its place.
    const sent = fake.requests[2].messages;
    const lastAssistant = sent.at(-2)!;
    expect(lastAssistant.content.some((b) => b.type === "tool_use")).toBe(false);
    const hint = sent.at(-1)!.content[0] as { text: string };
    expect(hint.text).toMatch(/cut off at the 128000-token output limit.*write_file src\/big\.ts/);
    expect(hint.text).toMatch(/append_file/);
    // The last part's result confirms the whole file parses.
    const lastResult = fake.requests[5].messages.at(-1)!.content[0] as { content: string };
    expect(lastResult.content).toMatch(/now 1050 lines\. It parses cleanly\./);
  });

  it("steers the solver to its own tools", () => {
    const hint = truncationHint({ id: "x", name: "create_file", input: {} }, 4096, SOLVER_TOOLS);
    expect(hint).toMatch(/create_file.*edit_file/);
    expect(hint).not.toMatch(/append_file|multi_edit/);
  });

  it("auto-continues a plain-text reply cut off at the cap and stitches it", async () => {
    const fake = installFakeProvider([
      { text: "Part A, ", stopReason: "max_tokens" },
      { text: "part B, ", stopReason: "max_tokens" },
      { text: "the end." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log, { maxIterations: 2 }));
    expect(result.summary).toBe("Part A, part B, the end.");
    expect(result.stopReason).toBe("finished");
    expect(result.metrics?.truncationRecoveries).toBe(2);
    const note = fake.requests[1].messages.at(-1)!.content[0] as { text: string };
    expect(note.text).toMatch(/Continue exactly where you stopped/);
  });
});

describe("append_file and multi_edit", () => {
  let ctx: ToolContext;
  let changes: FileChangeEvent[];
  beforeEach(() => {
    changes = [];
    ctx = {
      handle: ws.handle,
      engine: ws.engine,
      memory: ws.memory,
      agent: "test",
      commandPolicy: "never",
      editSession: createEditSession(),
      events: { onFileChange: (c) => changes.push(c) },
    };
  });

  it("append_file creates, appends after a missing newline, and reports parse status", async () => {
    expect(await runTool("append_file", { path: "src/n.ts", content: "export const a = 1;" }, ctx)).toMatch(
      /^Created src\/n\.ts: \+1 lines, now 1 lines\. It parses cleanly\./,
    );
    const half = await runTool("append_file", { path: "src/n.ts", content: "export function f() {\n" }, ctx);
    expect(half).toMatch(/does not parse yet/);
    await runTool("append_file", { path: "src/n.ts", content: "  return 1;\n}\n" }, ctx);
    expect(await readFile(ws.handle, "src/n.ts")).toBe("export const a = 1;\nexport function f() {\n  return 1;\n}\n");
    expect(changes.map((c) => c.kind)).toEqual(["create", "update", "update"]);
  });

  it("append_file respects write scope and edit approval", async () => {
    const scoped = { ...ctx, writeScope: ["src/ui/**"] };
    expect(await runTool("append_file", { path: "src/app.ts", content: "x" }, scoped)).toMatch(/^Refused: src\/app\.ts is outside/);

    const asks: unknown[] = [];
    const declining = {
      ...ctx,
      editPolicy: "ask" as const,
      events: { ...ctx.events, requestApproval: async (ask: unknown) => (asks.push(ask), false) },
    };
    expect(await runTool("append_file", { path: "src/app.ts", content: "// more\n" }, declining)).toMatch(/declined/);
    expect(asks).toHaveLength(1);
    expect(await readFile(ws.handle, "src/app.ts")).toBe("export function app() {\n  return 1;\n}\n");
    expect(changes).toHaveLength(0);
  });

  it("multi_edit applies every edit, in order, in one write", async () => {
    const out = await runTool(
      "multi_edit",
      {
        path: "src/app.ts",
        edits: [
          { old_str: "function app()", new_str: "function app(n: number)" },
          { old_str: "return 1;", new_str: "return n + 1;" },
        ],
        summary: "take n",
      },
      ctx,
    );
    expect(out).toMatch(/^Edited src\/app\.ts/);
    expect(out).toMatch(/2 edits applied/);
    expect(await readFile(ws.handle, "src/app.ts")).toBe("export function app(n: number) {\n  return n + 1;\n}\n");
    expect(changes).toHaveLength(1);
  });

  it("multi_edit is all-or-nothing and names the failing edit", async () => {
    const before = await readFile(ws.handle, "src/app.ts");
    const miss = await runTool(
      "multi_edit",
      { path: "src/app.ts", edits: [{ old_str: "return 1;", new_str: "return 2;" }, { old_str: "nope()", new_str: "x" }] },
      ctx,
    );
    expect(miss).toMatch(/^Error: edit 2 of 2 failed, so NONE of the edits were applied/);
    const broken = await runTool(
      "multi_edit",
      { path: "src/app.ts", edits: [{ old_str: "return 1;", new_str: "return (1;" }] },
      ctx,
    );
    expect(broken).toMatch(/NOT applied: it would make src\/app\.ts unparseable/);
    expect(await readFile(ws.handle, "src/app.ts")).toBe(before);
    expect(changes).toHaveLength(0);
  });

  it("edit results never echo a large replacement whole", async () => {
    const big = tsLines(0, 200);
    const out = await runTool("edit_file", { path: "src/app.ts", find: "  return 1;\n", replace: `  return 1;\n}\n${big}function tail() {\n` }, ctx);
    expect(out).toMatch(/lines not shown/);
    expect(out.split("\n").length).toBeLessThan(30);
  });
});

describe("pruning the transcript", () => {
  const bigContent = tsLines(0, 400);
  const bigView = `src/big.ts (400 lines)\n${bigContent}`;
  const turn = (id: string, name: string, toolInput: Record<string, unknown>, result: string): AiMessage[] => [
    { role: "assistant", content: [{ type: "tool_use", id, name, input: toolInput }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
  ];
  const transcript = (): AiMessage[] => [
    { role: "user", content: [{ type: "text", text: "task" }] },
    ...turn("w1", "write_file", { path: "src/big.ts", content: bigContent, summary: "s" }, "Created src/big.ts (401 lines)."),
    ...turn("f1", "finish", { summary: "done" }, `REJECTED: the gate says ${"x".repeat(800)}`),
    ...turn("v1", "read_file", { path: "src/big.ts" }, bigView),
    ...turn("v2", "read_file", { path: "src/app.ts" }, `src/app.ts\n${"y".repeat(800)}`),
    ...turn("e1", "edit_file", { path: "src/big.ts", find: "v1 = 1", replace: "v1 = 2" }, "Edited."),
    ...turn("r1", "run_command", { command: "ls" }, "ok"),
    ...turn("r2", "run_command", { command: "ls" }, "ok"),
  ];

  it("stubs old write payloads and stale views, and keeps recent turns and the gate's word", () => {
    const messages = transcript();
    const pruned = pruneTranscript(messages);
    const write = pruned.messages[1].content[0] as unknown as { input: { content: string } };
    expect(write.input.content).toMatch(/^\[wrote src\/big\.ts: 400 lines, sha [0-9a-f]{10}; view it with read_file if needed\]$/);
    const staleView = pruned.messages[6].content[0] as { content: string };
    expect(staleView.content).toMatch(/^\[elided: stale view of src\/big\.ts/);
    // A view of a file that did not change since stays.
    expect((pruned.messages[8].content[0] as { content: string }).content).toContain("yyyy");
    // The finish verdict and inputs are never touched.
    expect(pruned.messages[3]).toEqual(messages[3]);
    expect(pruned.messages[4]).toEqual(messages[4]);
    expect(pruned).toMatchObject({ stubbed: 1, staleViews: 1 });
    expect(pruned.removed).toBeGreaterThan(3000);
    // Pure, and idempotent.
    expect((messages[1].content[0] as unknown as { input: { content: string } }).input.content).toBe(bigContent);
    expect(pruneTranscript(pruned.messages).removed).toBe(0);
  });

  it("eliding old results never removes the latest finish verdict", () => {
    const elided = elideOldToolResults(transcript(), 2);
    expect((elided.messages[4].content[0] as { content: string }).content).toMatch(/^REJECTED/);
    expect((elided.messages[6].content[0] as { content: string }).content).toMatch(/^\[elided:/);
  });

  it("the runner prunes once written payloads pass the threshold and reports tokensElided", async () => {
    const files = [0, 1, 2, 3].map((i) => tsLines(i * 1000, 1000));
    const fake = installFakeProvider([
      ...files.map((content, i) => ({ calls: [{ name: "write_file", input: { path: `src/m${i}.ts`, content, summary: "m" } }] })),
      { calls: [{ name: "read_file", input: { path: "src/app.ts" } }] },
      { text: "All modules written." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log));
    expect(result.summary).toBe("All modules written.");
    expect(result.metrics?.tokensElided).toBeGreaterThan(4000);
    expect(log.of("compaction").length).toBeGreaterThan(0);
    const last = JSON.stringify(fake.requests.at(-1)!.messages);
    expect(last).toContain("[wrote src/m0.ts: 1000 lines");
    // The newest writes are still verbatim.
    expect(last).toContain("v3999 = 3999");
    for (const [i, content] of files.entries()) expect(await readFile(ws.handle, `src/m${i}.ts`)).toBe(content);
  });
});

describe("OpenAI-compatible finish_reason length", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AI_API_KEY", "AI_BASE_URL", "VIBERON_MAX_OUTPUT"];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_BASE_URL = "https://llm.example/v1";
    process.env.VIBERON_MAX_OUTPUT = "12000";
    invalidateCredentialCache();
    openAiCompatTesting.reset();
    openAiCompatTesting.setSleep(async () => {});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    invalidateCredentialCache();
    vi.unstubAllGlobals();
  });

  function stub(message: Record<string, unknown>) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ choices: [{ message, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 12000 } }),
          { status: 200 },
        );
      }),
    );
    return bodies;
  }

  const req = (): AiTurnRequest => ({
    model: "openai:test-model",
    system: [{ text: "SYS" }],
    messages: [{ role: "user", content: [{ type: "text", text: "write it" }] }],
    tools: [
      {
        name: "write_file",
        description: "Write.",
        input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      },
    ],
  });

  it("reports max_tokens and flags the cut-off call, honoring VIBERON_MAX_OUTPUT", async () => {
    const bodies = stub({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path": "a.ts", "content": "export const' } }],
    });
    const res = await openaiCompatProvider.runTurn(req());
    expect(bodies[0].max_tokens).toBe(12_000);
    expect(res.stopReason).toBe("max_tokens");
    expect(res.toolCalls[0]).toMatchObject({ name: "write_file", input: {}, inputError: TRUNCATED_CALL_ERROR });
  });

  it("flags the last call even when its truncated arguments happen to parse", async () => {
    stub({
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path": "a.ts"}' } }],
    });
    const res = await openaiCompatProvider.runTurn(req());
    expect(res.toolCalls[0]).toMatchObject({ inputError: TRUNCATED_CALL_ERROR, partialInput: { path: "a.ts" } });
  });

  it("plain text cut off is max_tokens with no calls", async () => {
    stub({ content: "The answer is" });
    const res = await openaiCompatProvider.runTurn(req());
    expect(res).toMatchObject({ stopReason: "max_tokens", toolCalls: [], text: "The answer is" });
  });
});
