import { describe, expect, it } from "vitest";

import type { AiToolDef } from "@/lib/ai/types";
import {
  parseJsonArgs,
  parseTextToolCalls,
  toTextMessages,
  truncateHallucination,
} from "@/lib/ai/textproto";

const TOOLS: AiToolDef[] = [
  {
    name: "submit",
    description: "Finish.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        verification_commands: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
    },
  },
  {
    name: "read_file",
    description: "Read.",
    input_schema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "number" } } },
  },
];

describe("parseTextToolCalls", () => {
  it("parses the canonical <tool> format with raw values and coercion", () => {
    const text =
      'Looking.\n<tool name="read_file">\n<path>src/a.py</path>\n<start_line>10</start_line>\n</tool>';
    const { prose, calls } = parseTextToolCalls(text, TOOLS);
    expect(prose).toBe("Looking.");
    expect(calls).toMatchObject([{ name: "read_file", input: { path: "src/a.py", start_line: 10 } }]);
  });

  it("parses tagged array items", () => {
    const text =
      '<tool name="submit">\n<summary>fixed</summary>\n<verification_commands>\n<command>node t.js</command>\n<command>npm test</command>\n</verification_commands>\n</tool>';
    expect(parseTextToolCalls(text, TOOLS).calls[0].input).toEqual({
      summary: "fixed",
      verification_commands: ["node t.js", "npm test"],
    });
  });

  it("parses invoke, Qwen, Hermes and fenced JSON styles", () => {
    expect(
      parseTextToolCalls('<invoke name="read_file"><parameter name="path">a.py</parameter></invoke>', TOOLS).calls[0],
    ).toMatchObject({ name: "read_file", input: { path: "a.py" } });
    expect(
      parseTextToolCalls("<function=read_file><parameter=path>b.py</parameter></function>", TOOLS).calls[0],
    ).toMatchObject({ name: "read_file", input: { path: "b.py" } });
    expect(
      parseTextToolCalls('<tool_call>{"name": "read_file", "arguments": {"path": "c.py"}}</tool_call>', TOOLS).calls[0],
    ).toMatchObject({ name: "read_file", input: { path: "c.py" } });
    expect(
      parseTextToolCalls('```json\n{"name": "read_file", "arguments": "{\\"path\\": \\"d.py\\"}"}\n```', TOOLS).calls[0],
    ).toMatchObject({ name: "read_file", input: { path: "d.py" } });
    expect(parseTextToolCalls('```json\n{"name": "nope", "arguments": {}}\n```', TOOLS).calls).toEqual([]);
  });

  it("drops results the model imagined after its call", () => {
    const text = '<tool name="read_file">\n<path>a.py</path>\n</tool>\n<result>\nthe answer is 42\n</result>';
    const cut = truncateHallucination(text);
    expect(cut).not.toContain("42");
    expect(truncateHallucination("<result> no call before </result>")).toContain("no call");
  });

  it("repairs sloppy JSON arguments", () => {
    expect(parseJsonArgs('{"a": "x\ny", "b": [1,2,],}')).toEqual({ a: "x\ny", b: [1, 2] });
    expect(() => parseJsonArgs("not json")).toThrow();
  });
});

describe("toTextMessages", () => {
  it("flattens tool calls and results into text with the tool contract in the system prompt", () => {
    const out = toTextMessages(
      "SYS",
      [
        { role: "user", content: [{ type: "text", text: "Fix it." }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.py" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x = 1" }] },
      ],
      TOOLS,
    );
    expect(out[0].role).toBe("system");
    expect(out[0].content).toMatch(/^SYS[\s\S]*# How to call tools[\s\S]*## read_file/);
    expect(out[2]).toEqual({ role: "assistant", content: '<tool name="read_file">\n<path>a.py</path>\n</tool>' });
    expect(out[3].content).toBe('<tool_result name="read_file">\nx = 1\n</tool_result>');
  });
});
