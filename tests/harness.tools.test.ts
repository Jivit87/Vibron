import { beforeEach, describe, expect, it } from "vitest";

import type { TodoItem } from "@/lib/agents/events";
import { ROLES } from "@/lib/agents/roles";
import { ContextLedger } from "@/lib/context/ledger";
import { inScope, isToolFailure, runTool, type ToolContext } from "@/lib/tools/registry";
import { readFile } from "@/lib/workspace";
import type { ApprovalAsk } from "@/lib/harness/runs";
import { searchTerms } from "@/lib/tools/navigate";
import { makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

const FILES = [
  { path: "src/a.ts", source: "export const a = 1;\n" },
  { path: "src/a.tsx", source: "export const b = 2;\n" },
  { path: "src/lib/util.ts", source: "export const u = 3;\n" },
];

let ws: TestWorkspace;
function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    agent: "Test",
    commandPolicy: "never",
    events: {},
    ...overrides,
  };
}

beforeEach(async () => {
  ws = await makeWorkspace(FILES);
});

describe("inScope", () => {
  it("is exact for plain paths — owning a.ts does not grant a.tsx", () => {
    const scope = { writeScope: ["src/a.ts"] };
    expect(inScope(scope, "src/a.ts")).toBe(true);
    expect(inScope(scope, "./src/a.ts")).toBe(true);
    expect(inScope(scope, "src/a.tsx")).toBe(false);
    expect(inScope(scope, "src/a.ts.bak")).toBe(false);
  });

  it("grants a subtree only through dir/** or dir/", () => {
    expect(inScope({ writeScope: ["src/lib/**"] }, "src/lib/deep/x.ts")).toBe(true);
    expect(inScope({ writeScope: ["src/lib/**"] }, "src/library.ts")).toBe(false);
    expect(inScope({ writeScope: ["src/lib/"] }, "src/lib/x.ts")).toBe(true);
    expect(inScope({ writeScope: ["src/lib"] }, "src/lib/x.ts")).toBe(false);
    expect(inScope({ writeScope: ["src/*.ts"] }, "src/a.ts")).toBe(true);
    expect(inScope({ writeScope: ["src/*.ts"] }, "src/a.tsx")).toBe(false);
    expect(inScope({ writeScope: [] }, "anything")).toBe(true);
  });
});

describe("runTool enforcement", () => {
  it("refuses tools outside the role's allowlist even when named directly", async () => {
    const assistant = ctx({ allowedTools: ROLES.assistant.tools });
    const out = await runTool("write_file", { path: "x.ts", content: "x", summary: "s" }, assistant);
    expect(out).toMatch(/^Refused: write_file is not available/);
    expect(isToolFailure(out)).toBe(true);
    expect(await readFile(ws.handle, "x.ts")).toBeNull();
  });

  it("scope-checks both ends of a rename", async () => {
    const scoped = ctx({ writeScope: ["src/new.ts"] });
    const out = await runTool("rename_file", { from: "src/a.ts", to: "src/new.ts", summary: "mv" }, scoped);
    expect(out).toContain("Refused: src/a.ts is outside your scope");
    expect(await readFile(ws.handle, "src/a.ts")).not.toBeNull();
  });

  it("todo_write emits the full list and sanitizes it", async () => {
    let seen: TodoItem[] = [];
    const out = await runTool(
      "todo_write",
      {
        todos: [
          { content: "Read the code", status: "completed" },
          { id: "b", content: "Write it", status: "in_progress" },
          { content: "", status: "pending" },
          { content: "Test", status: "bogus" },
        ],
      },
      ctx({ events: { onTodos: (items) => (seen = items) } }),
    );
    expect(out).toContain("1/3 completed");
    expect(seen).toEqual([
      { id: "1", content: "Read the code", status: "completed" },
      { id: "b", content: "Write it", status: "in_progress" },
      { id: "4", content: "Test", status: "pending" },
    ]);
  });

  it("routes edits through approval under editPolicy ask", async () => {
    const asks: ApprovalAsk[] = [];
    const deny = ctx({
      editPolicy: "ask",
      events: { requestApproval: async (ask) => (asks.push(ask), false) },
    });
    const out = await runTool("edit_file", { path: "src/a.ts", find: "1", replace: "$&2", summary: "bump" }, deny);
    expect(out).toContain("declined");
    expect(asks[0]).toMatchObject({ kind: "edit", title: "Edit src/a.ts", detail: { before: "export const a = 1;\n", after: "export const a = $&2;\n" } });
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 1;\n");

    const allow = ctx({ editPolicy: "ask", events: { requestApproval: async () => true } });
    await runTool("edit_file", { path: "src/a.ts", find: "1", replace: "$&2", summary: "bump" }, allow);
    // `replace` is literal: `$&` is not a back-reference.
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = $&2;\n");
  });
});

describe("ContextLedger.fork", () => {
  it("dedupes per agent while accounting rolls up to the run", () => {
    const run = new ContextLedger();
    const a = run.fork("a");
    const b = run.fork("b");
    expect(a.offer("read_file", "x.ts", "same text").deduped).toBe(false);
    expect(a.offer("read_file", "x.ts", "same text").deduped).toBe(true);
    // Agent B never saw it, so it must get the content, not a pointer.
    expect(b.offer("read_file", "x.ts", "same text").deduped).toBe(false);
    const snap = run.snapshot();
    expect(snap.events).toHaveLength(3);
    expect(snap.dedupedTokens).toBeGreaterThan(0);
    expect(snap.sentTokens).toBe(a.snapshot().sentTokens);
  });
});

describe("solver tools", () => {
  const big = [
    "import os",
    ...Array.from({ length: 300 }, (_, i) => `X${i} = ${i}`),
    "class Cart:",
    "    def total(self):",
    "        return sum(self.items)",
    "",
    "    def apply_discount(self, pct):",
    "        return self.total() * (1 - pct)",
    ...Array.from({ length: 200 }, (_, i) => `Y${i} = ${i}`),
  ].join("\n");

  it("gives the solver exactly seven tools", () => {
    expect(ROLES.solver.tools).toEqual(["run_command", "edit_file", "create_file", "view", "find_symbols", "compare", "finish"]);
  });

  it("view: numbers small files and ranges, outlines large ones with searched sections expanded", async () => {
    const c = ctx({ recentTerms: [] });
    expect(await runTool("view", { path: "src/a.ts" }, c)).toBe("src/a.ts (1 lines)\n     1\texport const a = 1;");
    await runTool("create_file", { path: "cart.py", content: big }, c);
    const outline = await runTool("view", { path: "cart.py" }, c);
    expect(outline).toMatch(/is long \(507 lines\)\. Outline/);
    expect(outline).toContain("   302\tclass Cart:");
    expect(outline).not.toContain("return sum(self.items)");
    c.recentTerms!.push("apply_discount");
    const expanded = await runTool("view", { path: "cart.py" }, c);
    expect(expanded).toMatch(/matching your recent searches \(apply_discount\) expanded at lines 306-307/);
    expect(expanded).toContain("return self.total() * (1 - pct)");
    expect(expanded).not.toContain("return sum(self.items)");
    expect(await runTool("view", { path: "cart.py", start_line: 303, end_line: 304 }, c)).toBe(
      "cart.py (lines 303-304 of 507)\n   303\t    def total(self):\n   304\t        return sum(self.items)",
    );
    expect(await runTool("view", { path: "src" }, c)).toMatch(/a\.ts\na\.tsx\nlib\/util\.ts/);
    expect(await runTool("view", { path: "nope/a.ts" }, c)).toMatch(/does not exist.*Did you mean: src\/a\.ts/);
  });

  it("find_symbols uses the graph and falls back to a definition grep", async () => {
    ws = await makeWorkspace([
      { path: "src/cart.ts", source: "export function cartTotal(xs: number[]) {\n  return xs.length;\n}\n" },
      { path: "src/use.ts", source: "import { cartTotal } from './cart';\nexport function show() {\n  return cartTotal([]);\n}\n" },
      { path: "cart.py", source: big },
      // Ruby is not parsed into the graph, so this one exercises the grep fallback.
      { path: "hooks.rb", source: "def legacy_hook(x)\n  x\nend\n" },
    ]);
    const found = await runTool("find_symbols", { query: "cartTotal" }, ctx());
    expect(found).toMatch(/src\/cart\.ts:1-3 {2}function cartTotal/);
    expect(found).toMatch(/called by: show \(src\/use\.ts:2\)/);
    expect(await runTool("find_symbols", { query: "Cart.apply_discount" }, ctx())).toMatch(/cart\.py:306-307 {2}function apply_discount/);
    expect(await runTool("find_symbols", { query: "legacy_hook" }, ctx())).toMatch(/hooks\.rb:1: def legacy_hook/);
    expect(await runTool("find_symbols", { query: "missing_thing" }, ctx())).toMatch(/No definition found/);
  });

  it("finish forwards the summary and reproduction to the harness", async () => {
    const seen: unknown[] = [];
    const c = ctx({ harness: { finish: async (input) => (seen.push(input), "VERIFIED.") } });
    expect(await runTool("finish", { summary: "fixed", reproduction: "$ node r.js" }, c)).toBe("VERIFIED.");
    expect(seen).toEqual([{ summary: "fixed", reproduction: "node r.js" }]);
  });
});

describe("searchTerms", () => {
  it("pulls identifiers out of grep, rg and find commands", () => {
    expect(searchTerms('grep -rn "def apply_discount" src | head -20')).toEqual(["apply_discount"]);
    expect(searchTerms("rg -g '*.py' -e CartTotal")).toEqual(["CartTotal"]);
    expect(searchTerms("git grep -n parse_url")).toEqual(["parse_url"]);
    expect(searchTerms("find . -name '*cart_utils*.py'")).toEqual(["cart_utils"]);
    expect(searchTerms("python -m pytest tests")).toEqual([]);
  });
});
