/**
 * Output hygiene for the model's context: keep the parts of a failing run
 * that explain the failure (tracebacks, assertion diffs, FAIL blocks,
 * panics) plus the summary tail, instead of a blind 40/60 character cut
 * that routinely drops the traceback (see ARCHITECTURE.md, output hygiene).
 */

import { cleanOutput } from "@/lib/verify/parse";

/** Lines that start or are part of an explanation of a failure. */
const TRIGGERS: RegExp[] = [
  /^Traceback \(most recent call last\)/,
  /^_{3,} .+ _{3,}$/, // pytest failure section header
  /^E\s{2,}\S/, // pytest assertion detail
  /^(FAIL|ERROR): \w+ \(/, // unittest
  /^(FAILED|ERROR)\s+\S+::/, // pytest -rA summary
  /\b(AssertionError|AssertionError:|assert\s)/,
  /^\s*(not ok) \d+/, // TAP
  /^\s*✖\s/, // node spec
  /^\s*--- FAIL:/, // go
  /^\s*(FAIL|×|✕)\s+\S/, // vitest/jest
  /^\s*●\s/, // jest failure block
  /panicked at/, // rust
  /^error(\[E\d+\])?:/, // rustc / tsc style
  /^\S+\.(py|ts|tsx|js|go|rs|java):\d+(:\d+)?:?\s.*(error|Error)/,
  /^\s*at .+:\d+:\d+\)?$/, // JS stack frames
  /\b(SyntaxError|TypeError|ReferenceError|ImportError|ModuleNotFoundError|NameError|KeyError|ValueError|AttributeError|IndexError|Exception)\b/,
  /^(Expected|Received|expected|actual)\b/,
  /^\s*[-+] (Expected|Received)/,
];

/** Lines that close a Python traceback. */
const EXCEPTION_LINE = /^[\w.]+(Error|Exception|Exit|Interrupt)\b|^[\w.]+: /;

interface Window {
  start: number;
  end: number;
}

/** Tracebacks, assertion diffs, FAIL blocks, plus the summary tail. */
export function extractFailures(output: string, maxChars = 4000): string {
  const all = cleanOutput(output).split("\n");
  const windows: Window[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!;
    if (!TRIGGERS.some((re) => re.test(line))) continue;
    let end = Math.min(all.length - 1, i + 6);
    if (/^\s*not ok \d+/.test(line)) {
      // TAP: the YAML diagnostic block runs to its "..." terminator.
      for (let k = i + 1; k < all.length && k < i + 40; k += 1) {
        end = k;
        if (/^\s*\.\.\.\s*$/.test(all[k]!)) break;
      }
    } else if (/^Traceback/.test(line)) {
      // Run to the exception line that ends the traceback.
      for (let k = i + 1; k < all.length && k < i + 400; k += 1) {
        end = k;
        if (!/^\s/.test(all[k]!) && EXCEPTION_LINE.test(all[k]!)) break;
      }
    }
    windows.push({ start: Math.max(0, i - 2), end });
  }
  const tailStart = Math.max(0, all.length - 15);
  if (windows.length === 0) {
    return clip(all.slice(tailStart).join("\n").trim(), maxChars, "tail");
  }
  // Merge overlapping windows.
  windows.sort((a, b) => a.start - b.start);
  const merged: Window[] = [];
  for (const w of windows) {
    const last = merged.at(-1);
    if (last && w.start <= last.end + 1) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  const tail = all.slice(tailStart).join("\n").trim();
  const budget = Math.max(200, maxChars - Math.min(tail.length, Math.floor(maxChars * 0.25)) - 40);
  const blocks: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const w of merged) {
    if (w.start >= tailStart) break;
    const block = all.slice(w.start, Math.min(w.end, tailStart - 1) + 1).join("\n").trim();
    if (!block || seen.has(block)) continue;
    seen.add(block);
    if (used + block.length > budget) {
      const room = budget - used;
      if (room > 200) blocks.push(clip(block, room, "head"));
      blocks.push(`[… ${merged.length - blocks.length} more failure block(s) omitted …]`);
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  const parts = [...blocks];
  if (tail) parts.push(`--- summary ---\n${clip(tail, Math.floor(maxChars * 0.25), "tail")}`);
  return clip(parts.join("\n\n"), maxChars, "head");
}

/** Passing output: short head + tail. Failing output: extracted failures + tail. */
export function condenseOutput(output: string, exitCode: number | null, maxChars = 6000): string {
  const clean = cleanOutput(output);
  if (clean.length <= maxChars) return clean;
  if (exitCode === 0) {
    const head = Math.floor(maxChars * 0.3);
    const tail = maxChars - head;
    const omitted = clean.slice(head, clean.length - tail);
    return `${clean.slice(0, head)}\n[… ${omitted.split("\n").length} lines omitted (passing output) …]\n${clean.slice(-tail)}`;
  }
  return `[failing output condensed from ${clean.length} chars: failure blocks + tail]\n${extractFailures(
    clean,
    maxChars - 80,
  )}`;
}

function clip(text: string, max: number, keep: "head" | "tail"): string {
  if (text.length <= max) return text;
  return keep === "head" ? `${text.slice(0, max - 12)}\n[… clipped]` : `[clipped …]\n${text.slice(-(max - 12))}`;
}
