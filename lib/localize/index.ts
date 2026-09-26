/**
 * Deterministic fault localization, zero model tokens (ported from Pramana
 * `repo/localize.py`). Signals, strongest first:
 *
 *  - traceback frames and file paths quoted in the issue (and in the output
 *    of the issue's own code, run on the ORIGINAL tree);
 *  - identifiers from the issue (backticked code, dotted names, CamelCase,
 *    snake_case, calls) resolved through the symbol graph;
 *  - BM25 between the issue and each file (identifiers split into words);
 *  - second hop: the source files the best-matching tests import.
 *
 * The result is a short ranked hint list, never a constraint, plus past
 * `fix` notes on the same area as lessons.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Graph, GraphNode } from "@/lib/graph";
import { runSnippets } from "@/lib/localize/snippets";
import { relevantLessons } from "@/lib/memory/graph";
import { parseRepo } from "@/lib/parser";
import { listRepoPaths, relatedTestFiles, type ShellRunner } from "@/lib/verify";

export { extractSnippets, runSnippets, type Snippet, type SnippetRun } from "@/lib/localize/snippets";

export interface LocalizedFile {
  path: string;
  score: number;
  why: string[];
}

export interface LocalizeResult {
  files: LocalizedFile[];
  /** `qualname (path:line)` for the symbols behind the top files. */
  symbols: string[];
  snippetRun?: { code: string; output: string; exitCode: number | null };
  testFiles: string[];
  /** Past `fix` notes on the same area (untrusted, may be outdated). */
  lessons: string[];
}

export interface LocalizeOptions {
  runSnippets?: boolean;
  timeoutMs?: number;
  topK?: number;
  /** Test seam for snippet runs. */
  run?: ShellRunner;
  signal?: AbortSignal;
}

const STOP = new Set(
  `a an the and or but if then else when while for to of in on at by with from as is are was were be been being it its
  this that these those there here i we you he she they them my our your their me us not no yes do does did done have has
  had can could should would will shall may might must also just only very more most less least so such than too into out
  up down over under again further once all any both each few other some same own what which who whom why how where
  about above after before below between during through until against among because use used using get gets got
  set sets new old one two three first second last next example expected actual output input result results error errors
  issue bug fix fixes problem work works working worked happen happens code line lines file files function method class
  value values return returns returned call calls called true false none null self cls def import print str int float
  bool list dict tuple type types object objects string strings number test tests see seems seem like want need please
  thanks thank hi hello following follow version versions python run running ran instead however currently now make
  makes made way case cases etc const let var require console log`.split(/\s+/),
);
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const DOTTED_RE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;
const BACKTICK_RE = /`{1,3}([^`]+?)`{1,3}/g;
const TRACE_RE = /File "([^"]+)", line (\d+)(?:, in ([\w<>]+))?/g;
const JS_TRACE_RE = /at (?:[\w.$<>]+ )?\(?([\w./\\-]+\.(?:js|ts|mjs|cjs|jsx|tsx)):(\d+):\d+\)?/g;
const PATH_RE =
  /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|toml|cfg|ini|yaml|yml|json))\b/g;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const CODE_EXTS = /\.(py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala)$/;
const VENDOR_RE = /(^|\/)(vendor|vendored|third_party|thirdparty|node_modules|static|dist|build|_vendor)(\/|$)|\.min\.(js|css)$/i;

function splitIdent(tok: string): string[] {
  return tok
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 1);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const [tok] of text.matchAll(IDENT_RE)) {
    const low = tok.toLowerCase();
    if (low.length > 2 && !STOP.has(low)) out.push(low);
    if (tok.includes("_") || /[a-z][A-Z]/.test(tok)) out.push(...splitIdent(tok).filter((p) => !STOP.has(p) && p.length > 2));
  }
  return out;
}

export function isTestPath(p: string): boolean {
  const low = p.toLowerCase();
  return (
    /(^|\/)(tests?|testing|spec|__tests__)(\/|$)/.test(low) ||
    /(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+)$/.test(low)
  );
}

/** Plain lowercase words name dozens of things; snake_case/CamelCase don't. */
function specificity(name: string): number {
  if (name.replace(/^_+|_+$/g, "").includes("_") || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name)) return 1;
  if (/^[A-Z]/.test(name)) return 0.8;
  return name.length <= 12 ? 0.25 : 0.6;
}

export interface IssueSignals {
  strong: string[];
  dotted: string[];
  frames: { file: string; line: number; func: string }[];
  paths: string[];
}

export function extractSignals(text: string): IssueSignals {
  const strong: string[] = [];
  for (const m of text.matchAll(BACKTICK_RE)) strong.push(...(m[1].match(IDENT_RE) ?? []));
  for (const m of text.matchAll(CALL_RE)) strong.push(m[1]);
  for (const [tok] of text.matchAll(IDENT_RE)) {
    if (tok.replace(/^_+|_+$/g, "").includes("_") || /[a-z][A-Z]/.test(tok) || /^[A-Z][a-z]+[A-Z]\w*$/.test(tok)) strong.push(tok);
  }
  const frames: IssueSignals["frames"] = [];
  for (const m of text.matchAll(TRACE_RE)) frames.push({ file: m[1], line: Number(m[2]), func: m[3] ?? "" });
  for (const m of text.matchAll(JS_TRACE_RE)) frames.push({ file: m[1], line: Number(m[2]), func: "" });
  const seen = new Set<string>();
  const uniq = strong.filter((s) => {
    if (STOP.has(s.toLowerCase()) || s.length < 3 || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  return {
    strong: uniq.slice(0, 80),
    dotted: [...new Set(text.match(DOTTED_RE) ?? [])].slice(0, 60),
    frames: frames.slice(-40),
    paths: [...new Set([...text.matchAll(PATH_RE)].map((m) => m[1]))].slice(0, 40),
  };
}

function matchPath(ref: string, suffixIndex: Map<string, string[]>): string[] {
  const clean = ref.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const cands = suffixIndex.get(clean.split("/").pop()!) ?? [];
  if (clean.includes("/")) {
    for (const depth of [3, 2]) {
      const tail = clean.split("/").slice(-depth).join("/");
      const exact = cands.filter((f) => f === tail || f.endsWith(`/${tail}`));
      if (exact.length) return exact;
    }
  }
  return cands.length <= 3 ? cands : [];
}

interface Candidate {
  path: string;
  score: number;
  why: string[];
  symbols: string[];
}

function bm25(queryTokens: string[], docs: Map<string, string>): Map<string, number> {
  const q = new Map<string, number>();
  for (const t of queryTokens) q.set(t, (q.get(t) ?? 0) + 1);
  const scores = new Map<string, number>();
  if (!q.size) return scores;
  const tfs = new Map<string, Map<string, number>>();
  const lens = new Map<string, number>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [rel, text] of docs) {
    const toks = tokenize(`${rel.replace(/\//g, " ")} ${text}`);
    const tf = new Map<string, number>();
    for (const t of toks) if (q.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tfs.set(rel, tf);
    lens.set(rel, toks.length);
    total += toks.length;
  }
  const n = docs.size || 1;
  const avg = total / n || 1;
  const k1 = 1.2;
  const b = 0.75;
  for (const [rel, tf] of tfs) {
    const dl = lens.get(rel) || 1;
    let s = 0;
    for (const [t, qf] of q) {
      const f = tf.get(t);
      if (!f) continue;
      const d = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      s += ((idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / avg))) * (1 + Math.log(qf));
    }
    if (s > 0) scores.set(rel, s);
  }
  return scores;
}

/** Repo source files a test imports (Python absolute imports, JS/TS relative imports). */
function importedSources(testRel: string, text: string, fileSet: Set<string>): string[] {
  const out: string[] = [];
  if (testRel.endsWith(".py")) {
    for (const m of text.slice(0, 200_000).matchAll(/^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w.]+)/gm)) {
      const mod = (m[1] ?? m[2]).replace(/^\.+|\.+$/g, "");
      if (!mod || /^(os|sys|re|unittest|pytest|typing)\b/.test(mod)) continue;
      const parts = mod.split(".");
      search: for (let cut = parts.length; cut > 0; cut -= 1) {
        const base = parts.slice(0, cut).join("/");
        for (const cand of [`${base}.py`, `${base}/__init__.py`, `src/${base}.py`, `src/${base}/__init__.py`]) {
          if (fileSet.has(cand)) {
            out.push(cand);
            break search;
          }
        }
      }
    }
  } else {
    for (const m of text.matchAll(/(?:require\(\s*|from\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(testRel), m[1]));
      for (const ext of ["", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", "/index.js", "/index.ts"]) {
        if (fileSet.has(base + ext)) {
          out.push(base + ext);
          break;
        }
      }
    }
  }
  return [...new Set(out)].slice(0, 12);
}

async function readDocs(root: string, files: string[], max = 12_000): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  await Promise.all(
    files.slice(0, max).map(async (rel) => {
      try {
        const abs = path.join(root, rel);
        if ((await stat(abs)).size > 400_000) return;
        docs.set(rel, await readFile(abs, "utf8"));
      } catch {
        // Unreadable: skip.
      }
    }),
  );
  return docs;
}

/** Rank the files most likely to need the change for `task`. */
export async function localize(
  root: string,
  task: string,
  graph: Graph | null,
  opts: LocalizeOptions = {},
): Promise<LocalizeResult> {
  const topK = opts.topK ?? 8;
  const files = listRepoPaths(root).filter((f) => CODE_EXTS.test(f) && !VENDOR_RE.test(f));
  const fileSet = new Set(files);
  const suffixIndex = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split("/").pop()!;
    suffixIndex.set(base, [...(suffixIndex.get(base) ?? []), f]);
  }

  let snippetRun: LocalizeResult["snippetRun"];
  let text = task;
  if (opts.runSnippets !== false) {
    try {
      const runs = await runSnippets(root, task, { timeoutMs: opts.timeoutMs, run: opts.run, signal: opts.signal });
      const pick = runs.find((r) => r.exitCode !== 0) ?? runs[0];
      if (pick) {
        snippetRun = { code: pick.code, output: pick.output, exitCode: pick.exitCode };
        // The traceback the issue's own code prints is the strongest signal we can get for free.
        text = `${task}\n${runs.map((r) => r.output).join("\n")}`;
      }
    } catch {
      // Snippets are a bonus; never fail localization over them.
    }
  }

  const docs = await readDocs(root, files);
  const symbolGraph = graph?.nodes.length ? graph : parseRepo([...docs].map(([p, source]) => ({ path: p, source }))).graph;
  const byName = new Map<string, GraphNode[]>();
  for (const node of symbolGraph.nodes) {
    if (VENDOR_RE.test(node.file)) continue;
    const leaf = node.name.split(".").pop()!;
    for (const key of new Set([node.name, leaf])) byName.set(key, [...(byName.get(key) ?? []), node]);
  }

  const cands = new Map<string, Candidate>();
  const bump = (p: string, score: number, reason: string, sym?: string) => {
    const c = cands.get(p) ?? { path: p, score: 0, why: [], symbols: [] };
    cands.set(p, c);
    c.score += score;
    if (reason && !c.why.includes(reason) && c.why.length < 4) c.why.push(reason);
    if (sym && !c.symbols.includes(sym) && c.symbols.length < 6) c.symbols.push(sym);
  };

  const { strong, dotted, frames, paths } = extractSignals(text);
  frames.forEach((frame, i) => {
    for (const rel of matchPath(frame.file, suffixIndex)) {
      bump(rel, 6 + (i === frames.length - 1 ? 3 : 0), "in traceback", `${frame.func || "frame"} (${rel}:${frame.line})`);
    }
  });
  for (const ref of paths) for (const rel of matchPath(ref, suffixIndex)) bump(rel, 5, "path mentioned in issue");
  for (const name of dotted) {
    const parts = name.split(".");
    for (let cut = parts.length; cut > 0; cut -= 1) {
      const mod = parts.slice(0, cut).join("/");
      const hits = files.filter((f) => f.endsWith(`${mod}.py`) || f.endsWith(`${mod}/__init__.py`));
      if (hits.length && hits.length <= 3) {
        for (const h of hits) bump(h, 3, `module \`${parts.slice(0, cut).join(".")}\``);
        break;
      }
    }
    const leaf = parts[parts.length - 1];
    const qual = parts.slice(-2).join(".");
    for (const node of (byName.get(qual) ?? byName.get(leaf) ?? []).slice(0, 6)) {
      bump(node.file, 3.5 * Math.max(specificity(leaf), 0.5), `defines \`${node.name}\``, `${node.name} (${node.file}:${node.startLine})`);
    }
  }
  for (const name of strong) {
    const defs = (byName.get(name) ?? []).filter((n) => n.name === name || n.name.endsWith(`.${name}`));
    if (!defs.length || defs.length > 25) continue;
    const w = (4 * specificity(name)) / Math.sqrt(defs.length);
    for (const node of defs.slice(0, 10)) bump(node.file, w, `defines \`${node.name}\``, `${node.name} (${node.file}:${node.startLine})`);
  }

  const lex = bm25(tokenize(text), docs);
  if (lex.size) {
    const max = Math.max(...lex.values());
    for (const [rel, s] of [...lex].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      bump(rel, (4 * s) / max, "");
      const c = cands.get(rel)!;
      if (!c.why.length) c.why.push("text similarity");
    }
  }

  // Second hop: the tests that best match the issue import the code they exercise.
  const byScore = () => [...cands.values()].sort((a, b) => b.score - a.score);
  const testCands = byScore().filter((c) => isTestPath(c.path)).slice(0, 3);
  const topTest = testCands[0]?.score || 1;
  for (const tc of testCands) {
    const testDirs = new Set(path.posix.dirname(tc.path).split("/").filter((d) => !["tests", "test", "testing", "src", "."].includes(d)));
    const stem = path.posix.basename(tc.path).replace(/\.[^.]+$/, "").replace(/^test_|_test$|\.(test|spec)$/g, "");
    for (const mod of importedSources(tc.path, docs.get(tc.path) ?? "", fileSet)) {
      if (isTestPath(mod) || mod.endsWith("__init__.py")) continue;
      let affinity = 1;
      if (path.posix.dirname(mod).split("/").some((d) => testDirs.has(d))) affinity += 0.6;
      if (path.posix.basename(mod).replace(/\.[^.]+$/, "") === stem) affinity += 0.6;
      bump(mod, (2 + (2 * tc.score) / topTest) * affinity, `imported by related test ${path.posix.basename(tc.path)}`);
    }
  }

  const ranked = byScore();
  const src = ranked.filter((c) => !isTestPath(c.path)).slice(0, topK);
  let testFiles = ranked.filter((c) => isTestPath(c.path)).slice(0, 4).map((c) => c.path);
  if (!testFiles.length && src.length) {
    testFiles = await relatedTestFiles(root, src.slice(0, 3).map((c) => c.path), symbolGraph, 4).catch(() => []);
  }

  let lessons: string[] = [];
  try {
    lessons = relevantLessons(root, { files: src.map((c) => c.path), task });
  } catch {
    // Memory is advisory.
  }

  return {
    files: src.map((c) => ({ path: c.path, score: Math.round(c.score * 100) / 100, why: c.why.length ? c.why : ["text similarity"] })),
    symbols: [...new Set(src.flatMap((c) => c.symbols))].slice(0, 16),
    snippetRun,
    testFiles,
    lessons,
  };
}

/** Compact text for a prompt. */
export function renderLocalization(result: LocalizeResult): string {
  if (!result.files.length && !result.testFiles.length) return "(no strong signals; start with find_symbols / grep)";
  const lines = result.files.map((f, i) => `${i + 1}. ${f.path}  [${f.why.join("; ")}]`);
  if (result.symbols.length) lines.push(`Symbols: ${result.symbols.slice(0, 8).join(", ")}`);
  if (result.testFiles.length) lines.push(`Related tests: ${result.testFiles.join(", ")}`);
  if (result.lessons.length) lines.push(`Past fixes nearby (untrusted, may be outdated):\n${result.lessons.map((l) => `- ${l}`).join("\n")}`);
  return lines.join("\n");
}
