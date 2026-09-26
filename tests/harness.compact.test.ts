import { afterEach, describe, expect, it } from "vitest";

import type { AiMessage } from "@/lib/ai/types";
import { elideOldToolResults, summarizeHistory, summaryModel } from "@/lib/harness/compact";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";

afterEach(() => uninstallFakeProvider());

/** task, then `turns` × (assistant tool_use, user tool_result). */
function transcript(turns: number): AiMessage[] {
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: "the task" }] }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "grep", input: { i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i} `.repeat(100) }] });
  }
  return messages;
}

function pairsIntact(messages: AiMessage[]): boolean {
  const uses = messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id));
  const results = messages.flatMap((m) =>
    m.content.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  return uses.length === results.length && uses.every((id) => results.includes(id));
}

describe("elideOldToolResults", () => {
  it("elides only results older than the last six turns and keeps pairing valid", () => {
    const { messages, removed } = elideOldToolResults(transcript(9));
    expect(removed).toBeGreaterThan(0);
    const results = messages.filter((m) => m.content[0].type === "tool_result");
    const elided = results.map((m) => (m.content[0] as { content: string }).content.startsWith("[elided:"));
    expect(elided).toEqual([true, true, true, false, false, false, false, false, false]);
    expect(pairsIntact(messages)).toBe(true);
    // Idempotent: a second pass finds nothing new.
    expect(elideOldToolResults(messages).removed).toBe(0);
  });

  it("does nothing on a short transcript", () => {
    expect(elideOldToolResults(transcript(3)).removed).toBe(0);
  });
});

describe("summarizeHistory", () => {
  it("summarizes the middle with the fast model and keeps roles alternating", async () => {
    const fake = installFakeProvider([{ text: "Learned X; edited Y." }]);
    const result = await summarizeHistory(transcript(9), { model: "claude-opus-5" });
    expect(fake.requests[0].model).toBe(summaryModel("claude-opus-5"));
    expect(summaryModel("claude-opus-5")).toBe("claude-haiku-4-5");
    const messages = result!.messages;
    expect(messages[0].role).toBe("user");
    expect(JSON.stringify(messages[0].content)).toContain("Learned X; edited Y.");
    expect(JSON.stringify(messages[0].content)).toContain("the task");
    expect(messages[1].role).toBe("assistant");
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    expect(pairsIntact(messages)).toBe(true);
    expect(messages).toHaveLength(1 + 6 * 2);
  });
});
