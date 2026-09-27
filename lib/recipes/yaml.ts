/**
 * A small, strict YAML subset for recipe files.
 *
 * No YAML parser is a direct dependency (js-yaml is only transitive), and a
 * recipe needs very little of YAML, so this implements exactly that little
 * and rejects everything else with a line-numbered error instead of guessing:
 *
 *   supported   block mappings and sequences (nested by spaces), `- key: v`
 *               compact items, plain / 'single' / "double" quoted scalars,
 *               one-line flow collections `[a, b]` and `{k: v}`, literal `|`
 *               and folded `>` block scalars with `-`/`+` chomping and an
 *               optional indentation digit, `#` comments, one leading `---`.
 *   rejected    anchors `&`, aliases `*`, tags `!`, directives `%`, complex
 *               keys `?`, merge keys `<<`, multiple documents, tabs in
 *               indentation, duplicate keys, multi-line plain or quoted
 *               scalars, multi-line flow collections.
 *
 * Plain scalars resolve like YAML 1.2's core schema: `null`/`~`/empty → null,
 * `true`/`false` → boolean, integers and decimals → number, anything else
 * (including `yes`/`no`) → string. Quoted scalars are always strings.
 *
 * `parseYaml` also returns the source line of every node, keyed by path
 * (`steps[2].agent.role`), so schema errors can point at the right line.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
  }
}

export interface YamlDocument {
  value: YamlValue;
  /** Path (`a.b[0].c`) → 1-based source line of that node. */
  lines: Map<string, number>;
}

/** Refuse inputs larger than this outright (recipes are small). */
export const MAX_YAML_BYTES = 256 * 1024;
const MAX_DEPTH = 32;

interface Line {
  /** 1-based line number in the source. */
  no: number;
  indent: number;
  /** Content after the indent, comment stripped, trailing space trimmed. */
  text: string;
  /** The untouched source line (for block scalars). */
  raw: string;
}

/* ------------------------------ scanning --------------------------------- */

/** Index of a `#` that starts a comment (outside quotes, after whitespace), or -1. */
function commentStart(text: string, lineNo: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") i += 1;
        else quote = null;
      }
    } else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return i;
    } else if ((ch === '"' || ch === "'") && startsScalar(text, i)) {
      quote = ch;
    }
  }
  if (quote) throw new YamlError(`unterminated ${quote === '"' ? "double" : "single"}-quoted string (multi-line quoted strings are not supported; use | for multi-line text)`, lineNo);
  return -1;
}

/** A quote opens a quoted scalar only where a scalar can start. */
function startsScalar(text: string, i: number): boolean {
  const before = text.slice(0, i).trimEnd();
  return before === "" || /(^|[\s[{,])-$/.test(before) || /[:[{,]$/.test(before) || before === "-";
}

function scanLines(source: string): Line[] {
  const lines: Line[] = [];
  const rawLines = source.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    const no = i + 1;
    const indentMatch = /^[ \t]*/.exec(raw)![0];
    const body = raw.slice(indentMatch.length);
    if (indentMatch.includes("\t") && body.trim() !== "") {
      throw new YamlError("tab characters are not allowed in indentation; use spaces", no);
    }
    lines.push({ no, indent: indentMatch.length, text: body, raw });
  }
  return lines;
}

/** The structural text of a line: comment stripped and trimmed; "" for blank/comment lines. */
function structural(line: Line): string {
  const cut = commentStart(line.text, line.no);
  return (cut === -1 ? line.text : line.text.slice(0, cut)).trimEnd();
}

/* ------------------------------- scalars --------------------------------- */

const INT_RE = /^[-+]?(0|[1-9]\d*)$/;
const FLOAT_RE = /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;

function resolvePlain(text: string, lineNo: number): YamlValue {
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (INT_RE.test(text) || FLOAT_RE.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  const first = text[0];
  if ("&*!%@`".includes(first)) {
    const what: Record<string, string> = {
      "&": "anchors (&)",
      "*": "aliases (*)",
      "!": "tags (!)",
      "%": "directives (%)",
      "@": "a plain scalar starting with @",
      "`": "a plain scalar starting with `",
    };
    throw new YamlError(`${what[first]} are not supported; quote the value if it is text`, lineNo);
  }
  if (first === "|" || first === ">") {
    throw new YamlError(`a block scalar indicator (${first}) must be the whole value on its line`, lineNo);
  }
  if (text.startsWith("? ") || text === "?") throw new YamlError("complex keys (?) are not supported", lineNo);
  if (/:(\s|$)/.test(text)) {
    throw new YamlError(`unexpected ": " inside a plain value; quote the value ("${text.slice(0, 40)}")`, lineNo);
  }
  if (text.startsWith("- ") || text === "-") {
    throw new YamlError("a sequence item cannot follow a key on the same line; put it on the next line", lineNo);
  }
  return text;
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
};

/** Parse a quoted scalar starting at `text[start]`; returns the value and the index after it. */
function readQuoted(text: string, start: number, lineNo: number): { value: string; end: number } {
  const quote = text[start];
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "x" || next === "u" || next === "U") {
        const width = next === "x" ? 2 : next === "u" ? 4 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
          throw new YamlError(`invalid \\${next} escape in double-quoted string`, lineNo);
        }
        const code = parseInt(hex, 16);
        if (code > 0x10ffff) throw new YamlError(`invalid code point \\${next}${hex}`, lineNo);
        out += String.fromCodePoint(code);
        i += 2 + width;
        continue;
      }
      const mapped = ESCAPES[next];
      if (mapped === undefined) throw new YamlError(`unknown escape \\${next} in double-quoted string`, lineNo);
      out += mapped;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  throw new YamlError("unterminated quoted string (multi-line quoted strings are not supported; use | for multi-line text)", lineNo);
}

/* ---------------------------- flow collections --------------------------- */

class FlowReader {
  i = 0;
  constructor(
    private readonly text: string,
    private readonly lineNo: number,
  ) {}

  private ws() {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i += 1;
  }

  private fail(message: string): never {
    throw new YamlError(message, this.lineNo);
  }

  read(depth: number): YamlValue {
    if (depth > MAX_DEPTH) this.fail("nesting is too deep");
    this.ws();
    const ch = this.text[this.i];
    if (ch === "[") return this.seq(depth);
    if (ch === "{") return this.map(depth);
    if (ch === '"' || ch === "'") {
      const { value, end } = readQuoted(this.text, this.i, this.lineNo);
      this.i = end;
      return value;
    }
    const start = this.i;
    while (this.i < this.text.length && !",[]{}".includes(this.text[this.i])) {
      if (this.text[this.i] === ":" && /[\s,\]}]|$/.test(this.text[this.i + 1] ?? "")) break;
      this.i += 1;
    }
    const plain = this.text.slice(start, this.i).trim();
    return resolvePlain(plain, this.lineNo);
  }

  private seq(depth: number): YamlValue[] {
    this.i += 1;
    const out: YamlValue[] = [];
    this.ws();
    if (this.text[this.i] === "]") {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.i >= this.text.length) this.fail("unterminated flow sequence (flow collections must fit on one line)");
      out.push(this.read(depth + 1));
      this.ws();
      const ch = this.text[this.i];
      if (ch === ",") {
        this.i += 1;
        this.ws();
        if (this.text[this.i] === "]") {
          this.i += 1;
          return out;
        }
        continue;
      }
      if (ch === "]") {
        this.i += 1;
        return out;
      }
      if (ch === undefined) this.fail("unterminated flow sequence (flow collections must fit on one line)");
      this.fail(`unexpected "${ch}" in flow sequence`);
    }
  }

  private map(depth: number): { [key: string]: YamlValue } {
    this.i += 1;
    const out: { [key: string]: YamlValue } = {};
    this.ws();
    if (this.text[this.i] === "}") {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.i >= this.text.length) this.fail("unterminated flow mapping (flow collections must fit on one line)");
      const key = this.read(depth + 1);
      if (typeof key === "object" && key !== null) this.fail("flow mapping keys must be scalars");
      this.ws();
      if (this.text[this.i] !== ":") this.fail(`expected ":" after key "${String(key)}" in flow mapping`);
      this.i += 1;
      this.ws();
      const next = this.text[this.i];
      const value = next === "," || next === "}" ? null : this.read(depth + 1);
      const name = key === null ? "" : String(key);
      if (Object.prototype.hasOwnProperty.call(out, name)) this.fail(`duplicate key "${name}"`);
      if (name === "<<") this.fail("merge keys (<<) are not supported");
      out[name] = value;
      this.ws();
      const ch = this.text[this.i];
      if (ch === ",") {
        this.i += 1;
        this.ws();
        if (this.text[this.i] === "}") {
          this.i += 1;
          return out;
        }
        continue;
      }
      if (ch === "}") {
        this.i += 1;
        return out;
      }
      if (ch === undefined) this.fail("unterminated flow mapping (flow collections must fit on one line)");
      this.fail(`unexpected "${ch}" in flow mapping`);
    }
  }

  done(): void {
    this.ws();
    if (this.i < this.text.length) this.fail(`unexpected text after a flow collection: "${this.text.slice(this.i, this.i + 20)}"`);
  }
}

/* ------------------------------- parser ---------------------------------- */

const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_./-]*)[ \t]*:(?=\s|$)/;

class Parser {
  i = 0;
  readonly positions = new Map<string, number>();

  constructor(private readonly lines: Line[]) {}

  /** Index of the next structural (non-blank, non-comment) line at or after `from`. */
  private nextContent(from = this.i): number {
    let j = from;
    while (j < this.lines.length && structural(this.lines[j]) === "") j += 1;
    return j;
  }

  document(): YamlValue {
    let j = this.nextContent(0);
    if (j < this.lines.length && structural(this.lines[j]) === "---" && this.lines[j].indent === 0) {
      this.i = j + 1;
      j = this.nextContent();
    }
    if (j >= this.lines.length) return null;
    const first = this.lines[j];
    if (first.indent !== 0) throw new YamlError("the document must start at column 1", first.no);
    this.i = j;
    const value = this.block(0, "", 0);
    const rest = this.nextContent();
    if (rest < this.lines.length) {
      const line = this.lines[rest];
      const text = structural(line);
      if (text === "---" || text === "...") throw new YamlError("multiple documents are not supported", line.no);
      throw new YamlError(line.indent > 0 ? "unexpected indentation" : `unexpected content "${text.slice(0, 40)}"`, line.no);
    }
    return value;
  }

  private record(path: string, lineNo: number) {
    if (!this.positions.has(path)) this.positions.set(path, lineNo);
  }

  /** A block node whose first line has exactly `indent` spaces. */
  private block(indent: number, path: string, depth: number): YamlValue {
    if (depth > MAX_DEPTH) throw new YamlError("nesting is too deep", this.lines[this.i]?.no ?? 0);
    const line = this.lines[this.i];
    const text = structural(line);
    this.record(path, line.no);
    if (text === "-" || text.startsWith("- ")) return this.sequence(indent, path, depth);
    // Anything shaped like `key: …` is a mapping; `splitKey` explains a bad key.
    if (KEY_RE.test(text) || isQuotedKey(text) || /^[^'"[{|>][^]*?:(\s|$)/.test(text)) return this.mapping(indent, path, depth);
    if (text.startsWith("? ")) throw new YamlError("complex keys (?) are not supported", line.no);
    // A lone scalar (only valid as the whole document or a nested value).
    this.i += 1;
    return this.inlineValue(text, line, indent, depth);
  }

  private mapping(indent: number, path: string, depth: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      const j = this.nextContent();
      if (j >= this.lines.length) break;
      const line = this.lines[j];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("unexpected indentation", line.no);
      const text = structural(line);
      if (text === "---" || text === "...") break;
      if (text === "-" || text.startsWith("- ")) {
        throw new YamlError("a sequence item cannot appear inside a mapping at the same indentation", line.no);
      }
      const { key, rest } = splitKey(text, line.no);
      if (key === "<<") throw new YamlError("merge keys (<<) are not supported", line.no);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      const childPath = path ? `${path}.${key}` : key;
      this.i = j + 1;
      this.record(childPath, line.no);
      if (rest === "") {
        out[key] = this.nested(indent, childPath, depth, true);
      } else {
        out[key] = this.inlineValue(rest, line, indent, depth);
      }
    }
    return out;
  }

  /**
   * The value on the lines after `key:` (or `-`). A sequence may sit at the
   * same indentation as its key (`allowSameIndentSeq`); anything else must be
   * indented further. Nothing there means null.
   */
  private nested(indent: number, path: string, depth: number, allowSameIndentSeq: boolean): YamlValue {
    const j = this.nextContent();
    if (j >= this.lines.length) return null;
    const line = this.lines[j];
    const text = structural(line);
    if (line.indent > indent) {
      this.i = j;
      return this.block(line.indent, path, depth + 1);
    }
    if (allowSameIndentSeq && line.indent === indent && (text === "-" || text.startsWith("- "))) {
      this.i = j;
      return this.sequence(indent, path, depth + 1);
    }
    return null;
  }

  private sequence(indent: number, path: string, depth: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const j = this.nextContent();
      if (j >= this.lines.length) break;
      const line = this.lines[j];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("unexpected indentation", line.no);
      const text = structural(line);
      if (!(text === "-" || text.startsWith("- "))) break;
      const itemPath = `${path}[${out.length}]`;
      this.record(itemPath, line.no);
      const after = text.slice(1);
      const rest = after.trimStart();
      if (rest === "") {
        this.i = j + 1;
        out.push(this.nested(indent, itemPath, depth, false));
        continue;
      }
      // `- key: v` or `- - x`: re-read the rest of the line as a block
      // node whose indentation is the column it starts at.
      const column = indent + 1 + (after.length - rest.length);
      const restRaw = line.text.slice(1 + (after.length - rest.length));
      if (rest === "-" || rest.startsWith("- ") || (KEY_RE.test(rest) || isQuotedKey(rest))) {
        this.lines[j] = { no: line.no, indent: column, text: restRaw, raw: line.raw };
        this.i = j;
        out.push(this.block(column, itemPath, depth + 1));
        continue;
      }
      this.i = j + 1;
      out.push(this.inlineValue(rest, line, indent, depth));
    }
    return out;
  }

  /** A value written on the same line as its key or dash. */
  private inlineValue(text: string, line: Line, indent: number, depth: number): YamlValue {
    const head = text[0];
    if (head === "|" || head === ">") return this.blockScalar(text, line, indent);
    if (text.startsWith("{{")) {
      throw new YamlError(`a value starting with "{{" must be quoted, e.g. "${text.slice(0, 30)}"`, line.no);
    }
    if (head === "[" || head === "{") {
      const reader = new FlowReader(text, line.no);
      const value = reader.read(depth);
      reader.done();
      return value;
    }
    if (head === '"' || head === "'") {
      const { value, end } = readQuoted(text, 0, line.no);
      const trailing = text.slice(end).trim();
      if (trailing) throw new YamlError(`unexpected text after a quoted string: "${trailing.slice(0, 30)}"`, line.no);
      return value;
    }
    const value = resolvePlain(text, line.no);
    // Continuation lines of a plain scalar would be silently folded by YAML.
    const j = this.nextContent();
    if (j < this.lines.length && this.lines[j].indent > indent && !isBlockStart(structural(this.lines[j]))) {
      throw new YamlError("multi-line plain values are not supported; use | or > for multi-line text", this.lines[j].no);
    }
    return value;
  }

  /** `|` / `>` with optional chomping (`-`/`+`) and indentation digit, in either order. */
  private blockScalar(header: string, line: Line, parentIndent: number): string {
    const m = /^([|>])([1-9])?([-+])?$|^([|>])([-+])([1-9])$/.exec(header.trim());
    if (!m) throw new YamlError(`invalid block scalar header "${header}"`, line.no);
    const style = m[1] ?? m[4];
    const explicit = Number(m[2] ?? m[6] ?? 0);
    const chomp = m[3] ?? m[5] ?? "";

    const collected: string[] = [];
    let contentIndent = explicit ? parentIndent + explicit : 0;
    let j = this.i;
    for (; j < this.lines.length; j += 1) {
      const raw = this.lines[j].raw;
      if (raw.trim() === "") {
        collected.push("");
        continue;
      }
      const ind = /^ */.exec(raw)![0].length;
      if (/^ *\t/.test(raw) && ind < (contentIndent || parentIndent + 1)) {
        throw new YamlError("tab characters are not allowed in indentation; use spaces", this.lines[j].no);
      }
      if (!contentIndent) {
        if (ind <= parentIndent) break;
        contentIndent = ind;
      }
      if (ind < contentIndent) {
        if (ind > parentIndent) throw new YamlError("block scalar line is less indented than the first line", this.lines[j].no);
        break;
      }
      collected.push(raw.slice(contentIndent));
    }
    // Trailing blank lines belong to chomping, not to the next node.
    let end = collected.length;
    while (end > 0 && collected[end - 1] === "") end -= 1;
    const trailingBlank = collected.length - end;
    const body = collected.slice(0, end);
    this.i = j;

    let text: string;
    if (style === "|") {
      text = body.join("\n");
    } else {
      text = "";
      for (let k = 0; k < body.length; k += 1) {
        const cur = body[k];
        if (k === 0) {
          text = cur;
          continue;
        }
        const prev = body[k - 1];
        const moreIndented = (s: string) => s.startsWith(" ") || s.startsWith("\t");
        if (cur === "") text += "\n";
        else if (prev === "" || moreIndented(cur) || moreIndented(prev)) text += (prev === "" ? "" : "\n") + cur;
        else text += ` ${cur}`;
      }
    }
    if (body.length === 0) return chomp === "+" ? "\n".repeat(trailingBlank) : "";
    if (chomp === "-") return text;
    if (chomp === "+") return `${text}\n${"\n".repeat(trailingBlank)}`;
    return `${text}\n`;
  }
}

function isBlockStart(text: string): boolean {
  return text === "-" || text.startsWith("- ") || KEY_RE.test(text) || isQuotedKey(text);
}

function isQuotedKey(text: string): boolean {
  if (text[0] !== '"' && text[0] !== "'") return false;
  try {
    const { end } = readQuoted(text, 0, 0);
    return /^[ \t]*:(\s|$)/.test(text.slice(end));
  } catch {
    return false;
  }
}

function splitKey(text: string, lineNo: number): { key: string; rest: string } {
  if (text[0] === '"' || text[0] === "'") {
    const { value, end } = readQuoted(text, 0, lineNo);
    const after = text.slice(end);
    const colon = /^[ \t]*:(\s|$)/.exec(after);
    if (!colon) throw new YamlError(`expected ":" after quoted key "${value}"`, lineNo);
    return { key: value, rest: after.slice(colon[0].length).trim() };
  }
  const m = KEY_RE.exec(text);
  if (!m) {
    if (text.startsWith("? ")) throw new YamlError("complex keys (?) are not supported", lineNo);
    if (/^[&*!]/.test(text)) throw new YamlError("anchors, aliases and tags are not supported", lineNo);
    throw new YamlError(
      /:(\s|$)/.test(text)
        ? `invalid key in "${text.slice(0, 40)}"; keys are letters, digits, _ . / - (quote anything else)`
        : `expected "key: value", found "${text.slice(0, 40)}"`,
      lineNo,
    );
  }
  return { key: m[1], rest: text.slice(m[0].length).trim() };
}

/** Parse the YAML subset described at the top of this file. Throws `YamlError`. */
export function parseYaml(source: string): YamlDocument {
  if (Buffer.byteLength(source, "utf8") > MAX_YAML_BYTES) {
    throw new YamlError(`the file is larger than ${MAX_YAML_BYTES / 1024} KB`, 1);
  }
  const lines = scanLines(source);
  for (const line of lines) {
    if (line.indent === 0 && /^%/.test(line.text)) throw new YamlError("directives (%) are not supported", line.no);
  }
  const parser = new Parser(lines);
  const value = parser.document();
  return { value, lines: parser.positions };
}
