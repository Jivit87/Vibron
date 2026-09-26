/**
 * Diff compression for the review tools (the PR-Agent mechanism): parse a
 * unified diff, drop deleted files and delete-only hunks, render each hunk
 * with new-file line numbers (`__new hunk__` / `__old hunk__`) so the model
 * can cite lines, then pack files into a token budget, the dominant
 * language first and larger files first within it. What did not fit is
 * listed, never silently dropped.
 */

import path from "node:path";

import { countTokens } from "@/lib/tokens";

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
}

export interface CompressedDiff {
  text: string;
  included: string[];
  omitted: string[];
  tokens: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  const clean = p.trim().replace(/^"|"$/g, "");
  return clean.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const start = (p: string): DiffFile => {
    file = { path: p, status: "modified", binary: false, hunks: [] };
    files.push(file);
    hunk = null;
    return file;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0];
      if (mark === "\\") continue;
      if (mark === "+") newLeft -= 1;
      else if (mark === "-") oldLeft -= 1;
      else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      (hunk as DiffHunk).lines.push(mark === "+" || mark === "-" ? line : ` ${line.slice(1)}`);
      continue;
    }
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      start(git[2]);
      continue;
    }
    const current = file as DiffFile | null;
    if (line.startsWith("--- ")) {
      if (!current || current.hunks.length) start(stripPrefix(line.slice(4)));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      const f = current ?? start(stripPrefix(target));
      if (target === "/dev/null") f.status = "deleted";
      else f.path = stripPrefix(target);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length).trim();
    } else if (/^Binary files .* differ$/.test(line)) current.binary = true;
    else {
      const m = HUNK.exec(line);
      if (!m) continue;
      hunk = { header: line, oldStart: Number(m[1]), newStart: Number(m[3]), lines: [] };
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      current.hunks.push(hunk);
    }
  }
  return files;
}

const isDeleteOnly = (h: DiffHunk) => !h.lines.some((l) => l.startsWith("+"));

/** One file, deletion-only hunks dropped, new-side lines numbered. */
export function renderFile(file: DiffFile): string {
  const out = [`## File: '${file.path}'`];
  for (const h of file.hunks) {
    if (isDeleteOnly(h)) continue;
    const added: string[] = [];
    const removed: string[] = [];
    let n = h.newStart;
    for (const line of h.lines) {
      if (line.startsWith("-")) {
        removed.push(line);
        continue;
      }
      added.push(`${n} ${line}`);
      if (line.startsWith(" ")) removed.push(line);
      n += 1;
    }
    out.push("", h.header, "__new hunk__", ...added);
    if (removed.some((l) => l.startsWith("-"))) out.push("__old hunk__", ...removed);
  }
  return out.join("\n");
}

/** New-side content of a file in the diff (context + added lines), for grounding suggestions. */
export function newSideLines(file: DiffFile): string[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => !l.startsWith("-")).map((l) => l.slice(1)));
}

export function compressDiff(diff: string, budgetTokens: number): CompressedDiff {
  const files = parseUnifiedDiff(diff);
  const deleted = files.filter((f) => f.status === "deleted").map((f) => f.path);
  const candidates = files
    .filter((f) => f.status !== "deleted" && !f.binary && f.hunks.some((h) => !isDeleteOnly(h)))
    .map((f) => {
      const text = renderFile(f);
      return { file: f, text, tokens: countTokens(text), ext: path.extname(f.path).toLowerCase() || f.path };
    });

  const share = new Map<string, number>();
  for (const c of candidates) share.set(c.ext, (share.get(c.ext) ?? 0) + c.tokens);
  candidates.sort((a, b) => share.get(b.ext)! - share.get(a.ext)! || a.ext.localeCompare(b.ext) || b.tokens - a.tokens);

  const parts: string[] = [];
  const included: string[] = [];
  const omitted: string[] = files.filter((f) => f.binary && f.status !== "deleted").map((f) => f.path);
  let used = 0;
  for (const c of candidates) {
    // +2 for the blank lines joining files.
    if (used + c.tokens + 2 > budgetTokens) {
      omitted.push(c.file.path);
      continue;
    }
    parts.push(c.text);
    included.push(c.file.path);
    used += c.tokens + 2;
  }
  const footer: string[] = [];
  if (omitted.length) footer.push(`Other changed files, not shown (budget): ${omitted.join(", ")}`);
  if (deleted.length) footer.push(`Deleted files: ${deleted.join(", ")}`);
  const text = [...parts, ...footer].join("\n\n");
  return { text, included, omitted, tokens: countTokens(text) };
}
