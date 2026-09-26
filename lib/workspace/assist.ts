/**
 * Editor assists: inline completion and ⌘K inline edit.
 *
 * Both are single tool-less model turns through `lib/ai`'s `runTurn`. The
 * prompt building and output cleanup are pure so they can be tested without
 * a provider; the turn function is injectable for the same reason.
 */

import { availableModels, resolveModel, runTurn } from "@/lib/ai";
import type { AiTurnHandlers, AiTurnRequest } from "@/lib/ai/types";

export type TurnFn = (
  request: AiTurnRequest,
  handlers?: AiTurnHandlers,
) => Promise<{ text: string }>;

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;

/** Fastest configured model, or the preferred one when it is usable. */
export async function pickModel(tier: "fast" | "balanced", preferred?: string): Promise<string> {
  const models = await availableModels();
  if (preferred && models.some((m) => m.available && m.spec.id === preferred)) return preferred;
  const order = tier === "fast" ? ["fast", "balanced", "frontier"] : ["balanced", "frontier", "fast"];
  for (const t of order) {
    const hit = models.find((m) => m.available && m.spec.tier === t);
    if (hit) return hit.spec.id;
  }
  return resolveModel("auto");
}

/** Remove a wrapping ``` fence the model added despite instructions. */
export function stripFence(text: string): string {
  const fenced = text.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1] : text;
}

/* ------------------------------- completion ------------------------------ */

const COMPLETE_SYSTEM = `You are a code completion engine inside an editor.
You receive the code before and after the cursor. Reply with ONLY the text to insert at the cursor:
no explanation, no code fences, no repetition of the surrounding code.
Prefer completing the current line or statement; never more than about 12 lines.
If nothing sensible should be inserted, reply with an empty message.`;

export function buildCompletionRequest(
  model: string,
  input: { path: string; language: string; prefix: string; suffix: string },
): AiTurnRequest {
  const prefix = input.prefix.slice(-PREFIX_CHARS);
  const suffix = input.suffix.slice(0, SUFFIX_CHARS);
  return {
    model,
    system: [{ text: COMPLETE_SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `File: ${input.path} (${input.language || "plain text"})\n<before_cursor>\n${prefix}</before_cursor>\n<after_cursor>\n${suffix}</after_cursor>`,
          },
        ],
      },
    ],
    maxTokens: 256,
    effort: "low",
  };
}

/**
 * Trim what the model repeated: text already before the cursor at the start,
 * and text already after the cursor at the end.
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = stripFence(raw).replace(/<\/?(before|after)_cursor>/g, "");
  if (!text.trim()) return "";
  // Overlap with the tail of the prefix (the current line, typically).
  const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length);
  // Overlap with the head of the suffix.
  const head = suffix.slice(0, 200);
  for (let n = Math.min(head.length, text.length); n > 0; n--) {
    if (text.endsWith(head.slice(0, n)) && head.slice(0, n).trim()) {
      text = text.slice(0, -n);
      break;
    }
  }
  return text;
}

export async function complete(
  input: { path: string; language: string; prefix: string; suffix: string },
  opts: { signal?: AbortSignal; turn?: TurnFn; model?: string } = {},
): Promise<string> {
  const model = opts.model ?? (await pickModel("fast"));
  const turn = opts.turn ?? runTurn;
  const result = await turn({ ...buildCompletionRequest(model, input), signal: opts.signal });
  return cleanCompletion(result.text, input.prefix, input.suffix);
}

/* ------------------------------- inline edit ----------------------------- */

const EDIT_SYSTEM = `You edit a selected region of a source file according to an instruction.
Reply with ONLY the complete replacement for the selected lines — no explanation and no code fences.
Keep the surrounding indentation style. Do not include code outside the selection.`;

const CONTEXT_LINES = 120;

export function buildInlineEditRequest(
  model: string,
  input: { path: string; source: string; startLine: number; endLine: number; instruction: string },
): AiTurnRequest {
  const lines = input.source.split("\n");
  const start = input.startLine - 1;
  const end = input.endLine;
  const before = lines.slice(Math.max(0, start - CONTEXT_LINES), start).join("\n");
  const selection = lines.slice(start, end).join("\n");
  const after = lines.slice(end, end + CONTEXT_LINES).join("\n");
  return {
    model,
    system: [{ text: EDIT_SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `File: ${input.path}\n<before>\n${before}\n</before>\n` +
              `<selection lines="${input.startLine}-${input.endLine}">\n${selection}\n</selection>\n` +
              `<after>\n${after}\n</after>\n\nInstruction: ${input.instruction}`,
          },
        ],
      },
    ],
    maxTokens: 4096,
    effort: "low",
  };
}

export function cleanReplacement(raw: string): string {
  return stripFence(raw.replace(/^\s*<selection[^>]*>\n?|\n?<\/selection>\s*$/g, ""));
}

export async function inlineEdit(
  input: { path: string; source: string; startLine: number; endLine: number; instruction: string },
  onDelta: (text: string) => void,
  opts: { signal?: AbortSignal; turn?: TurnFn; model?: string } = {},
): Promise<string> {
  const model = opts.model ?? (await pickModel("balanced"));
  const turn = opts.turn ?? runTurn;
  const result = await turn(
    { ...buildInlineEditRequest(model, input), signal: opts.signal },
    { onText: onDelta },
  );
  return cleanReplacement(result.text);
}
