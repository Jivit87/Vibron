/**
 * Lightweight symbol extractors for Python, Go, Rust and Java.
 *
 * No native dependencies and no language toolchains: Python is indentation
 * based, the brace languages use a string/comment-aware brace matcher. The
 * goal is a good-enough map (symbols with line ranges, imports, calls) for
 * navigation and localization, not a compiler front end. Ported from
 * Pramana's `repo/symbols.py` regex fallback, extended with end lines and
 * call/import extraction so the graph gets edges.
 */

import path from "node:path";

import type { GraphNode } from "@/lib/graph";
import { nodeId } from "@/lib/ids";
import type { ExtractedCall, ExtractedImport, SourceLanguage } from "@/lib/lang/extract/types";

export * from "@/lib/lang/extract/types";

export interface LanguageExtract {
  nodes: GraphNode[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}

const LANGUAGE_BY_EXTENSION: Record<string, SourceLanguage> = {
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export const SOURCE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

export function languageForPath(filePath: string): SourceLanguage | null {
  return LANGUAGE_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()] ?? null;
}

const MAX_LINES = 20_000;

interface Range {
  node: GraphNode;
  start: number;
  end: number;
}

export function extractLanguage(
  lang: Exclude<SourceLanguage, "js">,
  filePath: string,
  source: string,
): LanguageExtract {
  const lines = source.split(/\r?\n/).slice(0, MAX_LINES);
  switch (lang) {
    case "python":
      return extractPython(filePath, lines);
    case "go":
      return extractGo(filePath, lines);
    case "rust":
      return extractRust(filePath, lines);
    case "java":
      return extractJava(filePath, lines);
  }
}

/* -------------------------------- shared --------------------------------- */

function makeNode(
  filePath: string,
  lines: string[],
  name: string,
  kind: GraphNode["kind"],
  start: number,
  end: number,
  signatureEnd = start,
): GraphNode {
  const signature = lines
    .slice(start, Math.min(signatureEnd, start + 6) + 1)
    .map((l) => l.trim())
    .join(" ")
    .replace(/\s*\{\s*$/, "")
    .replace(/\s+/g, " ");
  return {
    id: nodeId(filePath, name, start + 1),
    kind,
    name,
    file: filePath,
    folder: filePath.split("/")[0] || ".",
    loc: Math.max(1, end - start + 1),
    signature: signature.length > 160 ? `${signature.slice(0, 157)}...` : signature,
    snippet: lines.slice(start, end + 1).join("\n").slice(0, 2000),
    startLine: start + 1,
    endLine: end + 1,
  };
}

/** Blank out string contents and line comments so regexes see only code. */
function maskLine(line: string, comment: "#" | "//"): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") {
        out += "  ";
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }
    if (comment === "#" && ch === "#") break;
    if (comment === "//" && ch === "/" && line[i + 1] === "/") break;
    if (ch === '"' || ch === "`" || (ch === "'" && comment === "#")) {
      quote = ch;
    }
    out += ch;
  }
  return out;
}

const CALL_RE = /(?:([A-Za-z_]\w*)\s*(?:\.|::))?([A-Za-z_]\w*)\s*(?:::<[^>]*>\s*)?\(/g;

function collectCalls(
  lines: string[],
  ranges: Range[],
  comment: "#" | "//",
  keywords: Set<string>,
): ExtractedCall[] {
  // Paint each line with its innermost enclosing symbol.
  const owner: (Range | undefined)[] = new Array(lines.length);
  const bySize = [...ranges].sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const range of bySize) {
    for (let i = range.start; i <= range.end && i < lines.length; i += 1) owner[i] = range;
  }
  const calls: ExtractedCall[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const range = owner[i];
    if (!range) continue;
    const masked = maskLine(lines[i]!, comment);
    CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALL_RE.exec(masked))) {
      const name = match[2]!;
      const namespace = match[1];
      if (keywords.has(name)) continue;
      const before = masked.slice(0, match.index);
      if (/\b(def|fn|func|class|struct|enum|trait|interface)\s*$/.test(before)) continue;
      if (i === range.start && name === range.node.name) continue;
      const key = `${range.node.id}:${namespace ?? ""}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        from: range.node.id,
        calleeName: name,
        namespace: namespace && !keywords.has(namespace) ? namespace : undefined,
      });
    }
  }
  return calls;
}

/**
 * Index of the line holding the `}` that closes the block opened at or after
 * `start`. Strings, char literals and comments are skipped; braces inside
 * parentheses (Go `interface{}` params) do not count.
 */
function blockEnd(lines: string[], start: number, lang: "go" | "rust" | "java"): number {
  let depth = 0;
  let parens = 0;
  let opened = false;
  let inBlockComment = false;
  let inRaw = false;
  const limit = Math.min(lines.length, start + 8000);
  for (let i = start; i < limit; i += 1) {
    let line = lines[i]!;
    if (lang === "go") line = line.replace(/\b(interface|struct)\{\}/g, "$1__");
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j]!;
      if (inBlockComment) {
        if (ch === "*" && line[j + 1] === "/") {
          inBlockComment = false;
          j += 1;
        }
        continue;
      }
      if (inRaw) {
        if (ch === "`") inRaw = false;
        continue;
      }
      if (ch === "/" && line[j + 1] === "/") break;
      if (ch === "/" && line[j + 1] === "*") {
        inBlockComment = true;
        j += 1;
        continue;
      }
      if (ch === "`" && lang === "go") {
        inRaw = true;
        continue;
      }
      if (ch === '"') {
        j += 1;
        while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
        continue;
      }
      if (ch === "'") {
        if (line[j + 1] === "\\") {
          const close = line.indexOf("'", j + 2);
          j = close === -1 ? j : close;
        } else if (line[j + 2] === "'") {
          j += 2;
        }
        continue;
      }
      if (ch === "(") parens += 1;
      else if (ch === ")") parens = Math.max(0, parens - 1);
      else if (ch === ";" && !opened && parens === 0) return i;
      else if (ch === "{" && parens === 0) {
        depth += 1;
        opened = true;
      } else if (ch === "}" && parens === 0 && opened) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    if (!opened && i - start > 8) return start;
  }
  return opened ? limit - 1 : start;
}

/* -------------------------------- Python --------------------------------- */

const PY_KEYWORDS = new Set([
  "if", "elif", "else", "for", "while", "return", "and", "or", "not", "in", "is",
  "with", "except", "lambda", "yield", "assert", "del", "print", "def", "class",
  "raise", "await", "async", "import", "from", "super", "self", "cls",
]);

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, "    ").length : 0;
}

/** For each line: does it start inside a triple-quoted string? */
function tripleStringMask(lines: string[]): boolean[] {
  const inside: boolean[] = new Array(lines.length).fill(false);
  let open: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    inside[i] = open !== null;
    const line = lines[i]!;
    let j = 0;
    while (j < line.length) {
      if (open) {
        const close = line.indexOf(open, j);
        if (close === -1) break;
        open = null;
        j = close + 3;
        continue;
      }
      const hash = line.indexOf("#", j);
      const dq = line.indexOf('"""', j);
      const sq = line.indexOf("'''", j);
      const candidates = [dq, sq].filter((n) => n !== -1);
      if (candidates.length === 0) break;
      const next = Math.min(...candidates);
      if (hash !== -1 && hash < next && !/["']/.test(line.slice(j, hash))) break;
      open = line.slice(next, next + 3);
      j = next + 3;
    }
  }
  return inside;
}

function extractPython(filePath: string, lines: string[]): LanguageExtract {
  const inString = tripleStringMask(lines);
  const nodes: GraphNode[] = [];
  const ranges: Range[] = [];
  const imports: ExtractedImport[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (inString[i]) continue;
    const line = lines[i]!;

    const importMatch = /^\s*import\s+(.+)$/.exec(line);
    if (importMatch) {
      for (const part of maskLine(importMatch[1]!, "#").split(",")) {
        const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (!m) continue;
        const request = m[1]!;
        imports.push({
          request,
          specifiers: [],
          namespaces: [m[2] ?? request.split(".").at(-1)!, request.split(".")[0]!],
        });
      }
      continue;
    }
    const fromMatch = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.*)$/.exec(line);
    if (fromMatch) {
      let names = maskLine(fromMatch[2]!, "#");
      if (names.includes("(") && !names.includes(")")) {
        for (let k = i + 1; k < lines.length && k < i + 200; k += 1) {
          names += ` ${maskLine(lines[k]!, "#")}`;
          if (lines[k]!.includes(")")) break;
        }
      }
      names = names.replace(/[()\\]/g, " ");
      const request = fromMatch[1]!;
      if (names.trim() === "*") {
        imports.push({ request, specifiers: [], namespaces: [], wildcard: true });
        continue;
      }
      const specifiers: [string, string][] = [];
      for (const part of names.split(",")) {
        const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) specifiers.push([m[2] ?? m[1]!, m[1]!]);
      }
      imports.push({ request, specifiers, namespaces: [] });
      continue;
    }

    const def = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!def) continue;
    const indent = indentOf(line);
    // Header may span lines: `def f(\n    a,\n):`
    let headerEnd = i;
    let depth = 0;
    for (let k = i; k < lines.length && k < i + 60; k += 1) {
      for (const ch of maskLine(lines[k]!, "#")) {
        if (ch === "(" || ch === "[") depth += 1;
        else if (ch === ")" || ch === "]") depth -= 1;
      }
      headerEnd = k;
      if (depth <= 0 && /:\s*(#.*)?$/.test(lines[k]!.trimEnd())) break;
      if (depth <= 0 && /:\s*\S/.test(maskLine(lines[k]!, "#")) && k === i) break;
    }
    let end = headerEnd;
    for (let k = headerEnd + 1; k < lines.length; k += 1) {
      const body = lines[k]!;
      if (inString[k]) {
        end = k;
        continue;
      }
      if (!body.trim() || body.trim().startsWith("#")) continue;
      if (indentOf(body) <= indent) break;
      end = k;
    }
    const kind = def[2] === "class" ? "class" : "function";
    const node = makeNode(filePath, lines, def[3]!, kind, i, end, headerEnd);
    nodes.push(node);
    ranges.push({ node, start: i, end });
  }

  return { nodes, imports, calls: collectCalls(lines, ranges, "#", PY_KEYWORDS) };
}

/* ---------------------------------- Go ----------------------------------- */

const GO_KEYWORDS = new Set([
  "if", "for", "switch", "return", "func", "go", "defer", "select", "range", "case",
  "make", "new", "len", "cap", "append", "panic", "recover", "copy", "delete", "string",
  "int", "int64", "byte", "error", "float64", "uint", "uint64", "rune", "bool",
]);

function extractGo(filePath: string, lines: string[]): LanguageExtract {
  const nodes: GraphNode[] = [];
  const ranges: Range[] = [];
  const imports: ExtractedImport[] = [
    // Same-package symbols are visible unqualified across files.
    { request: "__samepkg__", specifiers: [], namespaces: [], wildcard: true },
  ];

  const addImport = (spec: string) => {
    const m = /^\s*(?:([\w.]+)\s+)?"([^"]+)"/.exec(spec);
    if (!m || m[1] === "_" || m[1] === ".") return;
    imports.push({ request: m[2]!, specifiers: [], namespaces: [m[1] ?? m[2]!.split("/").at(-1)!] });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^import\s*\(/.test(line)) {
      for (let k = i + 1; k < lines.length && !/^\s*\)/.test(lines[k]!); k += 1) addImport(lines[k]!);
      continue;
    }
    const single = /^import\s+(.+)$/.exec(line);
    if (single) {
      addImport(single[1]!);
      continue;
    }
    const fn = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/.exec(line);
    const type = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\b/.exec(line);
    const match = fn ?? type;
    if (!match) continue;
    const end = blockEnd(lines, i, "go");
    const node = makeNode(filePath, lines, match[1]!, fn ? "function" : "class", i, end);
    nodes.push(node);
    ranges.push({ node, start: i, end });
  }

  return { nodes, imports, calls: collectCalls(lines, ranges, "//", GO_KEYWORDS) };
}

/* --------------------------------- Rust ---------------------------------- */

const RUST_KEYWORDS = new Set([
  "if", "while", "for", "match", "return", "fn", "loop", "Some", "Ok", "Err", "None",
  "Box", "Vec", "String", "println", "format", "vec", "panic", "assert", "assert_eq",
  "write", "writeln", "matches", "unreachable", "todo", "self", "Self", "super", "crate",
]);

function extractRust(filePath: string, lines: string[]): LanguageExtract {
  const nodes: GraphNode[] = [];
  const ranges: Range[] = [];
  const imports: ExtractedImport[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const useMatch = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(.*)$/.exec(line);
    if (useMatch) {
      let text = useMatch[1]!;
      for (let k = i + 1; !text.includes(";") && k < lines.length && k < i + 100; k += 1) {
        text += ` ${lines[k]!.trim()}`;
      }
      imports.push(...parseRustUse(text.replace(/;.*$/, "").replace(/\s+/g, "")));
      continue;
    }
    const modMatch = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/.exec(line);
    if (modMatch) {
      imports.push({ request: `self::${modMatch[1]}`, specifiers: [], namespaces: [modMatch[1]!] });
      continue;
    }
    const fn =
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(
        line,
      );
    const type = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/.exec(line);
    const match = fn ?? type;
    if (!match) continue;
    const end = blockEnd(lines, i, "rust");
    const node = makeNode(filePath, lines, match[1]!, fn ? "function" : "class", i, end);
    nodes.push(node);
    ranges.push({ node, start: i, end });
  }

  return { nodes, imports, calls: collectCalls(lines, ranges, "//", RUST_KEYWORDS) };
}

/** `crate::a::{b, c::d}` → one import per module path. */
function parseRustUse(text: string, prefix = ""): ExtractedImport[] {
  const brace = text.indexOf("{");
  if (brace === -1) {
    const full = prefix + text;
    if (full.endsWith("::*")) {
      return [{ request: full.slice(0, -3), specifiers: [], namespaces: [], wildcard: true }];
    }
    const alias = /^(.*?)as(\w+)$/.exec(full);
    const pathText = alias ? alias[1]! : full;
    const leaf = pathText.split("::").at(-1)!;
    const local = alias ? alias[2]! : leaf;
    if (leaf === "self") {
      const mod = pathText.slice(0, -6);
      return [{ request: mod, specifiers: [], namespaces: [mod.split("::").at(-1)!] }];
    }
    return [{ request: pathText, specifiers: [[local, leaf]], namespaces: [local] }];
  }
  const head = text.slice(0, brace);
  const inner = text.slice(brace + 1, text.lastIndexOf("}"));
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts.filter(Boolean).flatMap((part) => parseRustUse(part, prefix + head));
}

/* --------------------------------- Java ---------------------------------- */

const JAVA_KEYWORDS = new Set([
  "if", "for", "while", "switch", "return", "catch", "new", "throw", "synchronized",
  "super", "this", "try", "else", "case", "assert",
]);

function extractJava(filePath: string, lines: string[]): LanguageExtract {
  const nodes: GraphNode[] = [];
  const ranges: Range[] = [];
  const imports: ExtractedImport[] = [
    { request: "__samepkg__", specifiers: [], namespaces: [], wildcard: true },
  ];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const importMatch = /^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(line);
    if (importMatch) {
      const request = importMatch[1]!;
      if (importMatch[2]) {
        imports.push({ request, specifiers: [], namespaces: [], wildcard: true });
      } else {
        const leaf = request.split(".").at(-1)!;
        imports.push({ request, specifiers: [[leaf, leaf]], namespaces: [leaf] });
      }
      continue;
    }
    const type =
      /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/.exec(
        line,
      );
    let name: string | undefined;
    let kind: GraphNode["kind"] = "function";
    if (type) {
      name = type[1];
      kind = "class";
    } else if (!/^\s*(return|throw|new|else|case|package|import)\b/.test(line)) {
      const method =
        /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?[\w<>[\],.?]+(?:\s*<[^>]*>)?(?:\[\])*\s+([A-Za-z_]\w*)\s*\([^;]*$/.exec(
          line,
        ) ??
        /^\s*(?:public|private|protected)\s+([A-Z]\w*)\s*\([^;]*$/.exec(line);
      if (method && !JAVA_KEYWORDS.has(method[1]!)) name = method[1];
    }
    if (!name) continue;
    const end = blockEnd(lines, i, "java");
    const node = makeNode(filePath, lines, name, kind, i, end);
    nodes.push(node);
    ranges.push({ node, start: i, end });
  }

  return { nodes, imports, calls: collectCalls(lines, ranges, "//", JAVA_KEYWORDS) };
}
