/**
 * "Generate commit message" — one short, tool-less model turn over the
 * staged diff, routed through the provider abstraction in `lib/ai`.
 */

import { availableModels, resolveModel, runTurn } from "@/lib/ai";

const SYSTEM = `You write git commit messages.
Given a staged diff, reply with ONLY the commit message — no preamble, no code fences, no quotes.
Format: an imperative subject line of at most 72 characters (e.g. "Add retry to upload client"),
then, only if the change is non-trivial, a blank line and a short body (wrapped at 72 columns)
explaining what changed and why. Do not invent changes that are not in the diff.`;

/** Prefer a fast model: this is a small summarization job. */
async function pickModel(preferred: string): Promise<string> {
  if (preferred && preferred !== "auto") {
    return resolveModel(preferred);
  }
  const models = await availableModels();
  const fast = models.find((m) => m.available && m.spec.tier === "fast");
  if (fast) return fast.spec.id;
  return resolveModel("auto");
}

export function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  // Strip a wrapping code fence if the model added one anyway.
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  // And wrapping quotes.
  if (/^["'`][\s\S]*["'`]$/.test(text) && !text.includes("\n")) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export async function generateCommitMessage(
  diff: string,
  preferredModel = "auto",
): Promise<string> {
  const model = await pickModel(preferredModel);
  const result = await runTurn({
    model,
    system: [{ text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `Staged diff:\n\n${diff}` }],
      },
    ],
    maxTokens: 400,
    effort: "low",
  });
  const message = cleanCommitMessage(result.text);
  if (!message) throw new Error("The model returned an empty message.");
  return message;
}
