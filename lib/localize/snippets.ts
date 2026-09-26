/**
 * Zero-token reproduction (ported from Pramana `repo/snippets.py`): pull
 * runnable Python or JavaScript out of an issue and execute it on the
 * ORIGINAL code before the model's first turn. The traceback it prints also
 * feeds fault localization.
 *
 * Handles fenced blocks and doctest sessions (`>>>` / `...`). Output-only
 * blocks, tracebacks and shell sessions are skipped. Snippets run from
 * `.viberon/scratch/` (side effects stay out of the repo) with the repo on
 * PYTHONPATH, a scrubbed environment and a short timeout.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildRepoEnv, condenseOutput, execInRepo, type ShellRunner } from "@/lib/verify";

export interface Snippet {
  code: string;
  lang: "python" | "js";
  source: "fenced" | "doctest";
}

export interface SnippetRun {
  code: string;
  command: string;
  output: string;
  exitCode: number | null;
}

const FENCE_RE = /```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
const SHELL_HINT = /^\s*(\$ |pip |python -m pip|conda |git |cd |ls |export |npm |yarn |npx )/m;
const PY_LANGS = new Set(["python", "py", "python3", "pycon", "ipython"]);
const JS_LANGS = new Set(["js", "javascript", "node", "mjs", "cjs"]);
const JS_HINT = /\brequire\(|\bconsole\.log\(|^\s*(const|let|var)\s|=>|^\s*import\s.+\sfrom\s+['"]/m;

function fromDoctest(block: string): string | null {
  const lines = block.split("\n");
  if (!lines.some((l) => l.trimStart().startsWith(">>>"))) return null;
  const out: string[] = [];
  for (const line of lines) {
    const s = line.trimStart();
    if (s.startsWith(">>> ")) out.push(s.slice(4));
    else if (s === ">>>" || s === "...") out.push("");
    else if (s.startsWith("... ")) out.push(s.slice(4));
  }
  // Print bare expressions like the REPL would, so their values show up.
  const code = out
    .map((l) =>
      l && !/^\s/.test(l) && !/^(print|import|from|def|class|if|for|while|with|try|except|raise|return|assert|del|pass)\b/.test(l) && !/^[\w.[\]]+\s*[+\-*/]?=[^=]/.test(l)
        ? `print(repr(${l}))`
        : l,
    )
    .join("\n")
    .trim();
  return code || null;
}

/** Runnable snippets from issue text, at most `limit`. */
export function extractSnippets(text: string, limit = 2): Snippet[] {
  const found: Snippet[] = [];
  let blocks = [...text.matchAll(FENCE_RE)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }));
  if (!blocks.length && text.includes(">>>")) blocks = [{ lang: "", body: text }];
  for (const { lang, body: rawBody } of blocks) {
    if (lang && !PY_LANGS.has(lang) && !JS_LANGS.has(lang)) continue;
    const body = rawBody.replace(/^\n+|\n+$/g, "");
    if (!body.trim() || /^(Traceback|\$ |pip |Error|ERROR)/.test(body.trimStart())) continue;
    const doctest = fromDoctest(body);
    const isJs = JS_LANGS.has(lang) || (!lang && !doctest && JS_HINT.test(body));
    let code = doctest ?? body;
    if (!doctest && SHELL_HINT.test(body) && !/\bimport\b|\brequire\(/.test(body)) continue;
    if (code.length > 6000) continue;
    // It must exercise code: an import, a call, or an assertion.
    if (!/\bimport\b|\brequire\(|\w\(|\bassert\b/.test(code)) continue;
    if (isJs) code = code.replace(/(require\(\s*|from\s+|import\(\s*)(['"])(\.{1,2}\/)/g, (_m, pre, q, rel) => `${pre}${q}../../${rel === "./" ? "" : rel}`);
    found.push({ code, lang: isJs ? "js" : "python", source: doctest ? "doctest" : "fenced" });
    if (found.length >= limit) break;
  }
  return found;
}

/** A snippet that only defines test functions/classes does nothing as a script: run it with pytest. */
function isTestModule(code: string): boolean {
  const definesTests = /^(def test\w*\s*\(|class Test\w*)/m.test(code);
  const hasCalls = /^[A-Za-z_][\w.]*\s*\(/m.test(code);
  return definesTests && !hasCalls;
}

/** Run each snippet on the current (original) tree from `.viberon/scratch/`. */
export async function runSnippets(
  root: string,
  text: string,
  options: { timeoutMs?: number; run?: ShellRunner; signal?: AbortSignal } = {},
): Promise<SnippetRun[]> {
  const snippets = extractSnippets(text);
  if (!snippets.length) return [];
  const scratch = path.join(root, ".viberon", "scratch");
  mkdirSync(scratch, { recursive: true });
  const run: ShellRunner = options.run ?? ((cwd, command, o) => execInRepo(cwd, command, o));
  const results: SnippetRun[] = [];
  for (const [i, snippet] of snippets.entries()) {
    let name: string;
    let command: string;
    if (snippet.lang === "js") {
      name = `issue_snippet_${i + 1}.${/^\s*import\s/m.test(snippet.code) ? "mjs" : "cjs"}`;
      command = `node ${name}`;
    } else if (isTestModule(snippet.code)) {
      name = `test_issue_snippet_${i + 1}.py`;
      command = `python -m pytest -q -rA -p no:cacheprovider ${name}`;
    } else {
      name = `issue_snippet_${i + 1}.py`;
      command = `python ${name}`;
    }
    writeFileSync(path.join(scratch, name), `${snippet.code}\n`);
    // The repo env (venv + python shim, repo on PYTHONPATH, no API keys), run from scratch.
    const res = await run(scratch, command, {
      timeoutMs: options.timeoutMs ?? 30_000,
      signal: options.signal,
      env: buildRepoEnv(root),
    });
    results.push({
      code: snippet.code,
      command: `(cd .viberon/scratch && ${command})`,
      output: `${res.timedOut ? "[timed out]\n" : ""}${condenseOutput(res.output, res.exitCode, 4000)}`,
      exitCode: res.exitCode,
    });
  }
  return results;
}
