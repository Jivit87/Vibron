import { beforeEach, describe, expect, it } from "vitest";

import { ContextLedger } from "@/lib/context/ledger";
import type { EngineInput } from "@/lib/context/engine";
import { deriveMemory, emptyMemory } from "@/lib/memory";
import { parseRepo } from "@/lib/parser";
import { resetMemoryStoreForTests } from "@/lib/store";
import { runTool, type ToolContext } from "@/lib/tools/registry";
import type { WorkspaceHandle } from "@/lib/workspace";

/**
 * Covers the read-side tools an agent uses to orient itself, and the token
 * accounting that justifies the whole graph approach. These run against an
 * in-memory workspace so no disk or network is involved.
 */

const SHELL_SOURCE = [
  "/** Builds the public app shell. */",
  "export function createShell() {",
  "  return { title: 'Viberon' };",
  "}",
  "",
  "export function mountShell() {",
  "  return createShell();",
  "}",
  "",
].join("\n");

const ROUTER_SOURCE = [
  "/** Resolves a path to a route handler. */",
  "export function resolveRoute(path) {",
  "  return routes[path];",
  "}",
  "",
].join("\n");

const FILES = [
  { path: "src/shell.ts", source: SHELL_SOURCE },
  { path: "src/router.ts", source: ROUTER_SOURCE },
];

function buildContext(): { ctx: ToolContext; ledger: ContextLedger } {
  const parsed = parseRepo(FILES, "owner/repo@main");
  const memory = emptyMemory("fixture");
  deriveMemory(memory, FILES, parsed.graph);

  const ledger = new ContextLedger();
  const handle: WorkspaceHandle = {
    repoKey: "fixture",
    rootPath: null,
    repoRef: "owner/repo@main",
    label: "fixture",
  };
  const engine: EngineInput = {
    graph: parsed.graph,
    memory,
    fileInfo: FILES.map((f) => ({ path: f.path, tokenCount: 40 })),
    readFile: async (path) => FILES.find((f) => f.path === path)?.source ?? null,
    ledger,
  };

  return {
    ledger,
    ctx: {
      handle,
      engine,
      memory,
      agent: "Test",
      commandPolicy: "never",
      events: {},
    },
  };
}

describe("navigation tools", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
  });

  it("graph_search returns real source and line ranges, not just names", async () => {
    const { ctx } = buildContext();
    const result = await runTool(
      "graph_search",
      { query: "public app shell", max_symbols: 5 },
      ctx,
    );

    expect(result).toContain("createShell");
    expect(result).toContain("src/shell.ts");
    expect(result).toContain("return { title: 'Viberon' }");
  });

  it("graph_search reports what reading the files whole would have cost", async () => {
    const { ctx } = buildContext();
    const result = await runTool("graph_search", { query: "shell" }, ctx);

    // The footer is what makes the savings claim auditable rather than asserted.
    expect(result).toMatch(/graph slice: \d+ symbols from \d+ files/);
    expect(result).toMatch(/would have cost \d+/);
  });

  it("symbol_index maps files to their exports without sending source", async () => {
    const { ctx } = buildContext();
    const result = await runTool("symbol_index", {}, ctx);

    expect(result).toContain("src/shell.ts");
    expect(result).toContain("createShell");
    // The point of L1 is that bodies are absent.
    expect(result).not.toContain("return { title: 'Viberon' }");
  });

  it("symbol_index honours a filter", async () => {
    const { ctx } = buildContext();
    const result = await runTool("symbol_index", { filter: "router" }, ctx);

    expect(result).toContain("src/router.ts");
    expect(result).not.toContain("src/shell.ts");
  });

  it("symbol_outline gives signatures and line ranges but no bodies", async () => {
    const { ctx } = buildContext();
    const result = await runTool("symbol_outline", { path: "src/shell.ts" }, ctx);

    expect(result).toContain("createShell");
    expect(result).toMatch(/lines \d+-\d+/);
    expect(result).not.toContain("return { title: 'Viberon' }");
  });

  it("read_file honours a line range instead of returning the whole file", async () => {
    const { ctx } = buildContext();
    const result = await runTool(
      "read_file",
      { path: "src/shell.ts", start_line: 6, end_line: 8 },
      ctx,
    );

    expect(result).toContain("mountShell");
    // Lines outside the window must not leak in.
    expect(result).not.toContain("Builds the public app shell");
  });

  it("grep returns matching lines with paths and line numbers", async () => {
    const { ctx } = buildContext();
    const result = await runTool("grep", { pattern: "resolveRoute" }, ctx);

    expect(result).toMatch(/src\/router\.ts:\d+:/);
  });

  it("reports a missing file rather than throwing", async () => {
    const { ctx } = buildContext();
    const result = await runTool("read_file", { path: "nope.ts" }, ctx);
    expect(result).toContain("File not found");
  });

  it("reports an unknown tool rather than throwing", async () => {
    const { ctx } = buildContext();
    const result = await runTool("no_such_tool", {}, ctx);
    expect(result).toContain("unknown tool");
  });
});

describe("context ledger", () => {
  beforeEach(resetMemoryStoreForTests);

  it("collapses a repeated read to a pointer instead of resending it", async () => {
    const { ctx, ledger } = buildContext();

    const first = await runTool("read_file", { path: "src/shell.ts" }, ctx);
    const second = await runTool("read_file", { path: "src/shell.ts" }, ctx);

    expect(first).toContain("createShell");
    expect(second).toContain("already in context");
    expect(second).not.toContain("return { title: 'Viberon' }");

    const snapshot = ledger.snapshot();
    expect(snapshot.dedupedTokens).toBeGreaterThan(0);
  });

  it("charges the naive baseline so savings are measured, not assumed", async () => {
    const { ctx, ledger } = buildContext();
    await runTool("graph_search", { query: "shell" }, ctx);

    const snapshot = ledger.snapshot();
    expect(snapshot.baselineTokens).toBeGreaterThan(0);
    expect(snapshot.sentTokens).toBeGreaterThan(0);
    expect(snapshot.savedPercent).toBeGreaterThanOrEqual(0);
    expect(snapshot.savedPercent).toBeLessThanOrEqual(100);
  });

  it("re-delivers content after the path is invalidated by an edit", async () => {
    const { ctx, ledger } = buildContext();

    await runTool("read_file", { path: "src/shell.ts" }, ctx);
    ledger.invalidatePath("src/shell.ts");
    const afterEdit = await runTool("read_file", { path: "src/shell.ts" }, ctx);

    expect(afterEdit).toContain("createShell");
    expect(afterEdit).not.toContain("already in context");
  });
});

describe("memory tools", () => {
  beforeEach(resetMemoryStoreForTests);

  it("records an entry and dedupes a near-identical restatement", async () => {
    const { ctx } = buildContext();

    await runTool(
      "remember",
      { kind: "decision", text: "Use the graph for retrieval", why: "cheaper" },
      ctx,
    );
    await runTool(
      "remember",
      { kind: "decision", text: "use   the Graph for retrieval" },
      ctx,
    );

    expect(ctx.memory.decisions).toHaveLength(1);
    expect(ctx.memory.decisions[0].why).toBe("cheaper");
  });

  it("rejects an unknown memory kind", async () => {
    const { ctx } = buildContext();
    const result = await runTool("remember", { kind: "vibes", text: "x" }, ctx);
    expect(result).toContain("must be decision");
  });

  it("attaches a purpose to a file in the index", async () => {
    const { ctx } = buildContext();
    await runTool(
      "describe_file",
      { path: "src/shell.ts", purpose: "App shell factory." },
      ctx,
    );
    expect(ctx.memory.files["src/shell.ts"].purpose).toBe("App shell factory.");
  });
});
