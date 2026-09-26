/**
 * Pure text parsing for the composer: `@` mentions, `/` commands, custom
 * command templates, and code-block file targets.
 *
 * Kept free of React and the DOM so it is unit-testable and importable from
 * API routes (custom commands are parsed server-side).
 */

/* ------------------------------ mentions ---------------------------------- */

export interface TriggerMatch {
  /** Index of the trigger character (`@` or `/`). */
  start: number;
  /** Text typed after the trigger, up to the caret. */
  query: string;
}

/**
 * Find an in-progress `@mention` ending at the caret.
 *
 * The `@` must start the text or follow whitespace/an opening bracket, so
 * `user@example.com` never opens the popover. The query may not contain
 * whitespace — a space closes the mention.
 */
export function findMentionTrigger(text: string, caret: number): TriggerMatch | null {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let i = end - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? "" : text[i - 1];
      if (before !== "" && !/[\s([{"'`]/.test(before)) return null;
      const query = text.slice(i + 1, end);
      if (query.length > 200) return null;
      return { start: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

/**
 * Find an in-progress `/command` — only at the very start of the prompt and
 * only while the caret is still inside the command word.
 */
export function findSlashTrigger(text: string, caret: number): TriggerMatch | null {
  if (!text.startsWith("/")) return null;
  const word = /^\/[\w-]*/.exec(text)?.[0] ?? "/";
  if (caret > word.length || caret < 1) return null;
  return { start: 0, query: word.slice(1, caret) };
}

/** Remove the trigger token `[start, caret)` from the text. */
export function removeTrigger(
  text: string,
  start: number,
  caret: number,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  let after = text.slice(caret);
  // Swallow one space so removing "@foo " does not leave a double space.
  if (before.endsWith(" ") && after.startsWith(" ")) after = after.slice(1);
  return { text: before + after, caret: before.length };
}

/* --------------------------- slash commands ------------------------------- */

export interface ParsedSlash {
  name: string;
  args: string;
}

/** `"/fix the login bug"` → `{ name: "fix", args: "the login bug" }`. */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const match = /^\/([A-Za-z][\w-]*)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    // A bare "/cmd\nmore" still counts; the newline separates args.
    const multi = /^\/([A-Za-z][\w-]*)\n([\s\S]*)$/.exec(text.trim());
    if (!multi) return null;
    return { name: multi[1].toLowerCase(), args: multi[2].trim() };
  }
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Split arguments on whitespace, honouring "double" and 'single' quotes. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Expand a command template.
 *
 *   $ARGUMENTS / ${ARGUMENTS}  → the full argument string
 *   $1 … $9                    → positional arguments (quotes respected)
 *
 * When a template never mentions its arguments but some were given, they
 * are appended — otherwise `/review auth` would silently drop "auth".
 */
export function expandTemplate(template: string, args: string): string {
  const trimmed = args.trim();
  const positional = splitArgs(trimmed);
  let used = false;
  let out = template.replace(/\$\{ARGUMENTS\}|\$ARGUMENTS\b/g, () => {
    used = true;
    return trimmed;
  });
  out = out.replace(/\$([1-9])(?!\d)/g, (_, n: string) => {
    used = true;
    return positional[Number(n) - 1] ?? "";
  });
  out = out.trim();
  if (!used && trimmed) out = `${out}\n\n${trimmed}`;
  return out;
}

export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  intent?: "ask" | "build";
  template: string;
}

/**
 * Parse `.viberon/commands/<name>.md`.
 *
 * Optional YAML-ish frontmatter supports `description`, `argument-hint`,
 * and `intent` (ask|build). Without a description, the first non-empty
 * line of the body is used.
 */
export function parseCommandFile(fileName: string, source: string): CustomCommand | null {
  const base = fileName.split("/").pop() ?? fileName;
  const name = base.replace(/\.md$/i, "").toLowerCase();
  if (!/^[a-z][\w-]*$/.test(name)) return null;

  let body = source.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    body = body.slice(fm[0].length);
  }
  const template = body.trim();
  if (!template) return null;

  const firstLine =
    template
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "")
      .trim() ?? "";
  const description = (meta.description || firstLine).slice(0, 140);
  const intent =
    meta.intent === "ask" || meta.intent === "build" ? meta.intent : undefined;

  return {
    name,
    description,
    argumentHint: meta["argument-hint"] || undefined,
    intent,
    template,
  };
}

/* ------------------------------ ranking ----------------------------------- */

/**
 * Cheap fuzzy score: substring beats subsequence, basename beats path, and
 * earlier matches beat later ones. `-1` means no match.
 */
export function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  const bi = base.indexOf(q);
  if (bi >= 0) return 600 - bi;
  const ci = c.indexOf(q);
  if (ci >= 0) return 400 - Math.min(ci, 200);
  // Subsequence.
  let qi = 0;
  let gaps = 0;
  for (let i = 0; i < c.length && qi < q.length; i += 1) {
    if (c[i] === q[qi]) qi += 1;
    else if (qi > 0) gaps += 1;
  }
  return qi === q.length ? Math.max(1, 200 - gaps) : -1;
}

/* ---------------------------- code blocks --------------------------------- */

/**
 * Work out which file a fenced code block targets, if it says.
 *
 * Recognised, in order:
 *   ```ts path=src/a.ts        (meta attribute; also file= / title=)
 *   ```ts src/a.ts             (bare path in meta)
 *   ```ts:src/a.ts             (language:path)
 *   first line `// src/a.ts`, `# file: src/a.ts`, `<!-- src/a.ts -->`
 */
export function inferCodeBlockPath(
  lang: string | undefined,
  meta: string | undefined,
  code: string,
): string | null {
  const looksLikePath = (s: string) =>
    /^[\w.@~-][\w./@~-]*\.[A-Za-z0-9]{1,8}$/.test(s) && !s.includes("..");

  if (meta) {
    const attr = /(?:^|\s)(?:path|file|title|filename)=["']?([^\s"']+)["']?/.exec(meta);
    if (attr && looksLikePath(attr[1])) return attr[1];
    const bare = meta.trim().split(/\s+/)[0];
    if (bare && looksLikePath(bare)) return bare;
  }
  if (lang && lang.includes(":")) {
    const candidate = lang.slice(lang.indexOf(":") + 1);
    if (looksLikePath(candidate)) return candidate;
  }
  const first = code.split("\n", 1)[0]?.trim() ?? "";
  const comment =
    /^(?:\/\/|#|--|;|\/\*|<!--)\s*(?:file(?:name)?:|path:)?\s*([^\s*>]+?)\s*(?:\*\/|-->)?$/i.exec(
      first,
    );
  if (comment && looksLikePath(comment[1]) && comment[1].includes("/")) return comment[1];
  if (comment && /file(?:name)?:|path:/i.test(first) && looksLikePath(comment[1])) {
    return comment[1];
  }
  return null;
}

/** Rough token estimate (~4 chars per token) for the context meter. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
