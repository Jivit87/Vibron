import { describe, expect, it } from "vitest";

import {
  buildInlineEditRequest,
  cleanCompletion,
  cleanReplacement,
  complete,
  inlineEdit,
  type TurnFn,
} from "@/lib/workspace/assist";

describe("completion", () => {
  it("cleans fences and overlaps", () => {
    expect(cleanCompletion("```ts\nfoo()\n```", "", "")).toBe("foo()");
    expect(cleanCompletion("  const x = 1;", "a\n  const x", "")).toBe(" = 1;");
    expect(cleanCompletion("bar(1);\n}", "foo", "\n}")).toBe("bar(1);");
    expect(cleanCompletion("   ", "", "")).toBe("");
  });

  it("trims context and calls the turn function", async () => {
    let seen: Parameters<TurnFn>[0] | null = null;
    const turn: TurnFn = async (req) => {
      seen = req;
      return { text: "b + c;" };
    };
    const out = await complete(
      { path: "a.ts", language: "typescript", prefix: "x".repeat(10_000) + "a = ", suffix: "\n" },
      { turn, model: "m" },
    );
    expect(out).toBe("b + c;");
    const text = (seen!.messages[0].content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(7000);
    expect(seen!.maxTokens).toBe(256);
  });
});

describe("inline edit", () => {
  it("builds a selection-scoped prompt and streams deltas", async () => {
    const source = "a\nb\nc\nd";
    const req = buildInlineEditRequest("m", { path: "f.ts", source, startLine: 2, endLine: 3, instruction: "upper" });
    const text = (req.messages[0].content[0] as { text: string }).text;
    expect(text).toContain('<selection lines="2-3">\nb\nc\n</selection>');
    expect(text).toContain("<before>\na\n</before>");

    const deltas: string[] = [];
    const turn: TurnFn = async (_req, handlers) => {
      handlers?.onText?.("```\nB\n");
      handlers?.onText?.("C\n```");
      return { text: "```\nB\nC\n```" };
    };
    const out = await inlineEdit(
      { path: "f.ts", source, startLine: 2, endLine: 3, instruction: "upper" },
      (d) => deltas.push(d),
      { turn, model: "m" },
    );
    expect(out).toBe("B\nC");
    expect(deltas).toHaveLength(2);
    expect(cleanReplacement('<selection lines="1-1">\nx\n</selection>')).toBe("x");
  });
});
