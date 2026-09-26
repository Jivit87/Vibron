import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyStyle,
  checkEdit,
  createEditSession,
  splitStyle,
  strReplace,
  syntaxError,
} from "@/lib/tools/editor";
import { canonicalizeCall, knownTools, runTool, SOLVER_TOOLS, type ToolContext } from "@/lib/tools/registry";
import { putRawFiles } from "@/lib/store";
import { readFile } from "@/lib/workspace";
import { makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

describe("strReplace tolerance", () => {
  const file = "def f(x):\n    if x:\n        return 1\n    return 2\n";

  it("applies an exact unique match", () => {
    const out = strReplace(file, "return 1", "return 10");
    expect("after" in out && out.after).toContain("return 10");
  });

  it("strips line numbers pasted from a view", () => {
    const out = strReplace(file, "     3\t        return 1", "     3\t        return 11");
    expect("after" in out && out.after).toContain("        return 11");
    expect("note" in out && out.note).toMatch(/line numbers/);
  });

  it("ignores trailing whitespace", () => {
    const out = strReplace(file, "    if x:   \n        return 1", "    if x:\n        return 3");
    expect("after" in out && out.after).toContain("return 3");
  });

  it("re-indents a block matched ignoring indentation", () => {
    const out = strReplace(file, "if x:\n    return 1", "if x:\n    y = 5\n    return y");
    expect("after" in out && out.after).toBe("def f(x):\n    if x:\n        y = 5\n        return y\n    return 2\n");
    expect("note" in out && out.note).toMatch(/re-indented/);
  });

  it("refuses ambiguous matches and shows the lines", () => {
    const out = strReplace("a\nb\na\n", "a", "c");
    expect("error" in out && out.error).toMatch(/matches 2 times.*lines 1, 3/);
    expect(strReplace("a\nb\na\n", "a", "c", { replaceAll: true })).toMatchObject({ after: "c\nb\nc\n" });
  });

  it("points at the most similar region on a miss", () => {
    const out = strReplace(file, "    if y:\n        return 1", "x", { path: "f.py" });
    expect("error" in out && out.error).toMatch(/most similar region[\s\S]*lines 2-3/);
  });
});

describe("style preservation and lint gate", () => {
  it("round-trips CRLF and BOM", () => {
    const raw = "\ufeffa\r\nb\r\n";
    const { text, style } = splitStyle(raw);
    expect(text).toBe("a\nb\n");
    expect(applyStyle(text.replace("b", "c"), style)).toBe("\ufeffa\r\nc\r\n");
  });

  it("reports syntax errors for json and ts", async () => {
    expect(await syntaxError("x.json", "{")).toMatch(/JSON error/);
    expect(await syntaxError("x.ts", "const a: number = 1;")).toBeNull();
    expect(await syntaxError("x.ts", "const a = (;")).toMatch(/SyntaxError/);
    expect(await syntaxError("x.toml", "[[[")).toBeNull();
  });

  it("rejects an edit that breaks parsing, and flags oscillation", async () => {
    const session = createEditSession();
    const broken = await checkEdit(session, "a.ts", "const a = 1;\n", "const a = (1;\n");
    expect("error" in broken && broken.error).toMatch(/NOT applied/);
    const first = await checkEdit(session, "a.ts", "const a = 1;\n", "const a = 2;\n");
    expect("message" in first && first.message).not.toMatch(/back and forth/);
    const back = await checkEdit(session, "a.ts", "const a = 2;\n", "const a = 1;\n");
    expect("message" in back && back.message).toMatch(/back and forth/);
    expect(session.oscillations).toBe(1);
  });
});

describe("edit_file through the registry", () => {
  let ws: TestWorkspace;
  let ctx: ToolContext;
  beforeEach(async () => {
    ws = await makeWorkspace([{ path: "src/a.ts", source: "export const a = 1;\n" }]);
    ctx = {
      handle: ws.handle,
      engine: ws.engine,
      memory: ws.memory,
      agent: "test",
      commandPolicy: "never",
      editSession: createEditSession(),
      events: {},
    };
  });
  afterEach(() => undefined);

  it("preserves CRLF endings and a BOM", async () => {
    await putRawFiles(ws.handle.repoKey, [{ path: "src/win.ts", source: "\ufeffconst a = 1;\r\nconst b = 2;\r\n" }]);
    const out = await runTool("edit_file", { path: "src/win.ts", old_str: "const b = 2;", new_str: "const b = 3;" }, ctx);
    expect(out).toMatch(/^Edited src\/win.ts/);
    expect(await readFile(ws.handle, "src/win.ts")).toBe("\ufeffconst a = 1;\r\nconst b = 3;\r\n");
    expect(ctx.editSession?.touched).toEqual(["src/win.ts"]);
  });

  it("accepts the read_file line-number column in `find`", async () => {
    const out = await runTool("edit_file", { path: "src/a.ts", find: "    1\u2502 export const a = 1;", replace: "export const a = 2;" }, ctx);
    expect(out).toMatch(/pasted line numbers/);
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 2;\n");
  });

  it("refuses an edit that would not parse", async () => {
    const out = await runTool("edit_file", { path: "src/a.ts", find: "= 1;", replace: "= (1;", summary: "x" }, ctx);
    expect(out).toMatch(/^Error: edit NOT applied/);
    expect(await readFile(ws.handle, "src/a.ts")).toBe("export const a = 1;\n");
  });

  it("maps alias tools and reports ignored arguments", async () => {
    const out = await runTool("str_replace_editor", { command: "view", path: "src/a.ts", view_range: [1, 1], bogus: 1 }, ctx);
    expect(out).toContain("export const a = 1;");
    expect(out).toMatch(/Ignored unknown argument\(s\) for `view`: bogus/);
  });
});

describe("canonicalizeCall", () => {
  it("maps names, namespaces and argument spellings", () => {
    expect(canonicalizeCall("functions.bash", { cmd: "ls" })).toEqual({ name: "run_command", input: { command: "ls" } });
    expect(canonicalizeCall("view", { file_path: "a.py", lines: "10-20" })).toEqual({
      name: "view",
      input: { path: "a.py", start_line: 10, end_line: 20 },
    });
    expect(canonicalizeCall("read_file", { path: "a.py", offset: 5, limit: 10 })).toEqual({
      name: "read_file",
      input: { path: "a.py", start_line: 5, end_line: 14 },
    });
    expect(canonicalizeCall("str_replace_editor", { command: "create", path: "n.py", file_text: "x" })).toEqual({
      name: "create_file",
      input: { path: "n.py", content: "x" },
    });
    expect(canonicalizeCall("submit", { summary: "done", verification_commands: ["node r.js", "npm test"] })).toEqual({
      name: "finish",
      input: { summary: "done", reproduction: "node r.js" },
    });
    expect(canonicalizeCall("mystery", { old_str: "a", new_str: "b", path: "x" })?.name).toBe("edit_file");
    expect(canonicalizeCall("browser.open", { url: "x" })).toBeNull();
  });

  it("maps onto the tools the agent actually has", () => {
    const solver = knownTools(SOLVER_TOOLS);
    expect(canonicalizeCall("read_file", { path: "a.py", start_line: 3 }, solver)?.name).toBe("view");
    expect(canonicalizeCall("write_file", { path: "a.py", content: "x" }, solver)?.name).toBe("create_file");
    expect(canonicalizeCall("symbol_index", { filter: "Cart" }, solver)).toEqual({ name: "find_symbols", input: { query: "Cart" } });
    const interactive = knownTools(["read_file", "write_file", "symbol_index"]);
    expect(canonicalizeCall("view", { path: "a.py" }, interactive)?.name).toBe("read_file");
    expect(canonicalizeCall("create_file", { path: "a.py", content: "x" }, interactive)?.name).toBe("write_file");
  });
});
