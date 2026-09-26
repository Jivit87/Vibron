/**
 * Client side of `POST /api/review` (review / describe / improve / learn).
 *
 * The route is built in parallel with this UI, so every reader is tolerant:
 * a result may arrive bare or wrapped (`{ review }`, `{ result }`,
 * `{ suggestions }`), and each field accepts the obvious aliases. Nothing
 * here throws on a malformed body; unreadable rows are dropped.
 */

import { isMockMode, mockReviewResponse } from "@/lib/client/mock-run";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  title: string;
  detail: string;
}

export interface ReviewResult {
  summary: string;
  effort?: number;
  findings: Finding[];
  security: string | null;
  tests?: "adequate" | "missing" | "n/a";
  /** Files the diff compressor left out, when the route reports them. */
  omitted: string[];
}

export interface Described {
  title: string;
  body: string;
  type?: string;
}

export interface Suggestion {
  file: string;
  startLine: number;
  endLine: number;
  existing: string;
  improved: string;
  why: string;
  score: number;
}

export type ReviewTool = "review" | "describe" | "improve" | "learn";
export type ReviewTarget = "working" | "staged" | { base: string } | { prUrl: string };

/* -------------------------------- readers -------------------------------- */

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function int(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** Unwrap `{ result }`, `{ data }` and the tool-named key, once each. */
function unwrap(body: unknown, key: string): unknown {
  let b = body;
  for (const k of ["result", "data", key]) {
    const r = rec(b);
    if (r && k in r && r[k] !== undefined && r[k] !== null) b = r[k];
  }
  return b;
}

export function normalizeSeverity(value: unknown): Severity {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "high" || s === "critical" || s === "error" || s === "major") return "high";
  if (s === "medium" || s === "moderate" || s === "warning" || s === "med") return "medium";
  return "low";
}

export function normalizeFinding(raw: unknown): Finding | null {
  const r = rec(raw);
  if (!r) return null;
  const title = str(r.title) ?? str(r.summary) ?? str(r.message) ?? str(r.issue);
  if (!title) return null;
  let file = str(r.file) ?? str(r.path) ?? str(r.relevantFile) ?? str(r.relevant_file) ?? "";
  let line = int(r.line) ?? int(r.startLine) ?? int(r.start_line);
  // "src/a.ts:12" in the file field.
  const m = /^(.*):(\d+)$/.exec(file);
  if (m && line === undefined) {
    file = m[1];
    line = Number(m[2]);
  }
  return {
    file,
    line: line !== undefined && line > 0 ? line : undefined,
    severity: normalizeSeverity(r.severity ?? r.level ?? r.priority),
    title: title.trim(),
    detail: (str(r.detail) ?? str(r.body) ?? str(r.description) ?? str(r.explanation) ?? "").trim(),
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function normalizeReview(body: unknown): ReviewResult | null {
  const r = rec(unwrap(body, "review"));
  if (!r) return null;
  const list = Array.isArray(r.findings) ? r.findings : Array.isArray(r.issues) ? r.issues : [];
  const findings = list
    .map(normalizeFinding)
    .filter((f): f is Finding => f !== null)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const summary = (str(r.summary) ?? "").trim();
  if (!summary && findings.length === 0 && !("findings" in r)) return null;
  const effort = int(r.effort);
  const testsRaw = typeof r.tests === "string" ? r.tests.toLowerCase() : undefined;
  const tests =
    testsRaw === "adequate" || testsRaw === "missing" || testsRaw === "n/a" ? testsRaw : undefined;
  const security = str(r.security) ?? null;
  const omittedRaw = r.omitted ?? rec(r.compression)?.omitted;
  const omitted = Array.isArray(omittedRaw) ? omittedRaw.filter((x): x is string => typeof x === "string") : [];
  return {
    summary,
    effort: effort !== undefined ? Math.min(5, Math.max(1, effort)) : undefined,
    findings,
    security: security && !/^(none|no|null|n\/a)\.?$/i.test(security.trim()) ? security.trim() : null,
    tests,
    omitted,
  };
}

export function normalizeDescribe(body: unknown): Described | null {
  const r = rec(unwrap(body, "describe")) ?? rec(unwrap(body, "description"));
  if (!r) return null;
  const title = str(r.title);
  if (!title) return null;
  return {
    title: title.trim(),
    body: (str(r.body) ?? str(r.description) ?? "").trim(),
    type: str(r.type),
  };
}

export function normalizeSuggestion(raw: unknown): Suggestion | null {
  const r = rec(raw);
  if (!r) return null;
  const file = str(r.file) ?? str(r.path) ?? str(r.relevantFile) ?? str(r.relevant_file);
  const existing = typeof r.existing === "string" ? r.existing : typeof r.existingCode === "string" ? r.existingCode : typeof r.existing_code === "string" ? r.existing_code : undefined;
  const improved = typeof r.improved === "string" ? r.improved : typeof r.improvedCode === "string" ? r.improvedCode : typeof r.improved_code === "string" ? r.improved_code : undefined;
  if (!file || existing === undefined || improved === undefined || !existing.trim()) return null;
  const startLine = int(r.startLine) ?? int(r.start_line) ?? int(r.line) ?? 0;
  const endLine = int(r.endLine) ?? int(r.end_line) ?? startLine;
  const scoreRaw = typeof r.score === "number" ? r.score : Number(r.score);
  return {
    file,
    startLine,
    endLine: Math.max(startLine, endLine),
    existing,
    improved,
    why: (str(r.why) ?? str(r.summary) ?? str(r.content) ?? "").trim(),
    score: Number.isFinite(scoreRaw) ? Math.max(0, Math.min(10, scoreRaw)) : 0,
  };
}

export function normalizeSuggestions(body: unknown): Suggestion[] {
  const list = Array.isArray(body) ? body : unwrap(body, "suggestions");
  return (Array.isArray(list) ? list : [])
    .map(normalizeSuggestion)
    .filter((s): s is Suggestion => s !== null)
    .sort((a, b) => b.score - a.score);
}

/** `learn` answers with a count or the notes it wrote. */
export function normalizeLearn(body: unknown): { count: number; notes: string[] } {
  const r = rec(unwrap(body, "learn")) ?? {};
  const list = Array.isArray(r.notes) ? r.notes : Array.isArray(r.conventions) ? r.conventions : [];
  const notes = list
    .map((n) => (typeof n === "string" ? n : str(rec(n)?.title) ?? str(rec(n)?.path) ?? str(rec(n)?.text)))
    .filter((n): n is string => Boolean(n));
  return { count: int(r.count) ?? int(r.written) ?? notes.length, notes };
}

/* ---------------------------- apply suggestion --------------------------- */

export type ApplyResult = { ok: true; source: string } | { ok: false; reason: "out_of_date" };

function normEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line.trimEnd() === b[i].trimEnd());
}

/**
 * Replace `existing` with `improved` only if `existing` is still what the
 * file says. The line range is tried first (trailing whitespace ignored);
 * otherwise a single exact occurrence anywhere in the file is accepted, since
 * a line shift above the snippet does not make the suggestion wrong. Zero or
 * several occurrences means the file changed under the suggestion.
 */
export function applySuggestion(source: string, s: Pick<Suggestion, "startLine" | "endLine" | "existing" | "improved">): ApplyResult {
  const text = normEol(source);
  const existing = normEol(s.existing).replace(/\n$/, "");
  const improved = normEol(s.improved).replace(/\n$/, "");
  if (!existing) return { ok: false, reason: "out_of_date" };
  const lines = text.split("\n");
  const want = existing.split("\n");
  if (s.startLine > 0) {
    const from = s.startLine - 1;
    const slice = lines.slice(from, from + want.length);
    if (sameLines(slice, want)) {
      const next = [...lines.slice(0, from), ...improved.split("\n"), ...lines.slice(from + want.length)];
      return { ok: true, source: next.join("\n") };
    }
  }
  const first = text.indexOf(existing);
  if (first === -1 || text.indexOf(existing, first + 1) !== -1) return { ok: false, reason: "out_of_date" };
  return { ok: true, source: text.slice(0, first) + improved + text.slice(first + existing.length) };
}

/* ------------------------------ findings --------------------------------- */

/** Findings for one file, matching repo-relative paths loosely (`./`, `a/`, `b/`). */
export function findingsForPath(findings: readonly Finding[], path: string): Finding[] {
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/^[ab]\//, "");
  const target = norm(path);
  return findings.filter((f) => f.file && norm(f.file) === target);
}

export function findingLocation(f: Pick<Finding, "file" | "line">): string {
  return f.line ? `${f.file}:${f.line}` : f.file;
}

/* --------------------------------- API ----------------------------------- */

export interface ReviewResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

export async function postReview(
  input: { repoKey: string; target?: ReviewTarget; tool: ReviewTool; model?: string; repoUrl?: string },
  signal?: AbortSignal,
): Promise<ReviewResponse> {
  if (isMockMode()) return mockReviewResponse(input.tool, input.target);
  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const error =
        str(rec(body)?.error) ??
        (response.status === 404 ? "The review API is not available on this server." : `Review failed (HTTP ${response.status})`);
      return { ok: false, status: response.status, body, error };
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") return { ok: false, status: 0, body: null, error: "Cancelled" };
    return { ok: false, status: 0, body: null, error: "Network error" };
  }
}

export function isPrUrl(value: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(value.trim());
}
