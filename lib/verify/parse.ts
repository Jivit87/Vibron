/**
 * Per-framework test output parsers → per-test outcomes. Each parser is
 * tolerant: unknown lines are ignored, and `parseTestOutput` falls back to
 * trying every parser when the framework is ambiguous (e.g. `npm test`).
 */

import { stripAnsi } from "@/lib/terminal/output";
import type { TestFramework, TestOutcome } from "@/lib/verify/types";

export interface ParsedTests {
  tests: Record<string, TestOutcome>;
  /** Totals printed by the runner itself, when found (more reliable than counting). */
  summary: Partial<Record<"passed" | "failed" | "errors" | "skipped", number>> | null;
}

type Parser = (output: string) => ParsedTests;

function lines(output: string): string[] {
  return cleanOutput(output).split("\n");
}

/** Strip ANSI and collapse `\r` progress redraws to their final state. */
export function cleanOutput(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter((s) => s.trim());
      return segments.at(-1) ?? "";
    })
    .join("\n");
}

function countSummary(text: string, words: Record<string, "passed" | "failed" | "errors" | "skipped">) {
  const summary: ParsedTests["summary"] = {};
  let found = false;
  for (const [word, key] of Object.entries(words)) {
    const match = new RegExp(`(\\d+)\\s+${word}\\b`, "i").exec(text);
    if (match) {
      summary[key] = Number(match[1]);
      found = true;
    }
  }
  return found ? summary : null;
}

/* -------------------------------- Python --------------------------------- */

export const parsePytest: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  const all = lines(output);
  for (const line of all) {
    // -rA short summary: "PASSED tests/test_x.py::test_a", "FAILED tests/x.py::t - msg"
    let m = /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S+::\S+)/.exec(line);
    if (m) {
      tests[m[2]!] = pytestOutcome(m[1]!);
      continue;
    }
    // -v: "tests/test_x.py::test_a PASSED [ 50%]"
    m = /^(\S+::\S+)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/.exec(line);
    if (m) {
      tests[m[1]!] = pytestOutcome(m[2]!);
      continue;
    }
    // Collection error for a whole module: "ERROR tests/test_x.py - ImportError".
    m = /^ERROR\s+(\S+\.py)\b/.exec(line);
    if (m) tests[m[1]!] = "error";
  }
  const last = [...all].reverse().find((l) => /^=+ .*(passed|failed|error|skipped|no tests ran).* =+$/.test(l.trim()));
  return {
    tests,
    summary: last
      ? countSummary(last, { passed: "passed", failed: "failed", errors: "errors", error: "errors", skipped: "skipped" })
      : null,
  };
};

function pytestOutcome(word: string): TestOutcome {
  switch (word) {
    case "PASSED":
    case "XFAIL":
      return "pass";
    case "FAILED":
    case "XPASS":
      return "fail";
    case "ERROR":
      return "error";
    default:
      return "skip";
  }
}

export const parseUnittest: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  const all = lines(output);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!;
    // "test_x (tests.test_mod.TestC.test_x) ... ok"  (3.11+ includes the method)
    // "test_x (tests.test_mod.TestC) ... FAIL"        (older)
    const m = /^(\w+) \(([\w.]+)\)(?:\n.*)?\s*\.\.\.\s*(ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)\s*$/.exec(line);
    const head = m ?? /^(\w+) \(([\w.]+)\)\s*$/.exec(line);
    if (!head) continue;
    let verdict = m?.[3];
    if (!verdict) {
      // Docstring variant: the "... ok" lands on the next line.
      const next = /^.*\.\.\.\s*(ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)\s*$/.exec(all[i + 1] ?? "");
      if (!next) continue;
      verdict = next[1];
    }
    const [, name, where] = head;
    const id = where!.endsWith(`.${name}`) ? where! : `${where}.${name}`;
    tests[id] =
      verdict === "ok" || verdict === "expected failure"
        ? "pass"
        : verdict === "FAIL" || verdict === "unexpected success"
          ? "fail"
          : verdict === "ERROR"
            ? "error"
            : "skip";
  }
  // Error blocks for tests that never printed a verdict line (import errors).
  for (const line of all) {
    const m = /^(ERROR|FAIL): (\w+) \(([\w.]+)\)/.exec(line);
    if (!m) continue;
    const id = m[3]!.endsWith(`.${m[2]}`) ? m[3]! : `${m[3]}.${m[2]}`;
    if (!tests[id]) tests[id] = m[1] === "ERROR" ? "error" : "fail";
  }
  const ran = all.find((l) => /^Ran \d+ tests?/.test(l));
  let summary: ParsedTests["summary"] = null;
  if (ran) {
    const total = Number(/^Ran (\d+)/.exec(ran)![1]);
    const tail = all.slice(all.indexOf(ran)).join(" ");
    const failures = Number(/failures=(\d+)/.exec(tail)?.[1] ?? 0);
    const errors = Number(/errors=(\d+)/.exec(tail)?.[1] ?? 0);
    const skipped = Number(/skipped=(\d+)/.exec(tail)?.[1] ?? 0);
    summary = { passed: total - failures - errors - skipped, failed: failures, errors, skipped };
  }
  return { tests, summary };
};

/* ---------------------------------- Go ----------------------------------- */

export const parseGo: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  for (const line of lines(output)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const event = JSON.parse(trimmed) as { Action?: string; Package?: string; Test?: string };
        if (event.Test && (event.Action === "pass" || event.Action === "fail" || event.Action === "skip")) {
          tests[`${event.Package ?? ""}/${event.Test}`] =
            event.Action === "pass" ? "pass" : event.Action === "fail" ? "fail" : "skip";
        }
        continue;
      } catch {
        // Not JSON: fall through to text.
      }
    }
    const m = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(line);
    if (m) tests[m[2]!] = m[1] === "PASS" ? "pass" : m[1] === "FAIL" ? "fail" : "skip";
  }
  return { tests, summary: null };
};

/* --------------------------------- Rust ---------------------------------- */

export const parseCargo: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  for (const line of lines(output)) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line);
    if (m) tests[m[1]!] = m[2] === "ok" ? "pass" : m[2] === "FAILED" ? "fail" : "skip";
  }
  const result = lines(output).filter((l) => /^test result:/.test(l));
  let summary: ParsedTests["summary"] = null;
  if (result.length) {
    summary = { passed: 0, failed: 0, skipped: 0 };
    for (const line of result) {
      summary.passed! += Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
      summary.failed! += Number(/(\d+) failed/.exec(line)?.[1] ?? 0);
      summary.skipped! += Number(/(\d+) ignored/.exec(line)?.[1] ?? 0);
    }
  }
  return { tests, summary };
};

/* ------------------------------ JavaScript ------------------------------- */

/** `node --test`: TAP (non-TTY default) and the spec reporter. */
export const parseNodeTest: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  const stack: { indent: number; name: string }[] = [];
  const all = lines(output);
  for (const line of all) {
    const subtest = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (subtest) {
      const indent = subtest[1]!.length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      stack.push({ indent, name: subtest[2]!.trim() });
      continue;
    }
    const tap = /^(\s*)(ok|not ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO).*)?$/.exec(line);
    if (tap) {
      const indent = tap[1]!.length;
      while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
      const parents = stack.filter((s) => s.indent < indent).map((s) => s.name);
      const name = [...parents, tap[3]!.trim()].join(" > ");
      if (stack.length && stack.at(-1)!.indent === indent) stack.pop();
      tests[name] = tap[4] ? "skip" : tap[2] === "ok" ? "pass" : "fail";
      continue;
    }
    const spec = /^\s*(✔|✖|﹣|-)\s+(.+?)(?:\s+\([\d.]+m?s\))?(?:\s+#\s*SKIP)?$/.exec(line);
    if (spec && !/^\s*(✔|✖)\s+(tests|suites|pass|fail)\b/.test(line) && spec[1] !== "-") {
      tests[spec[2]!.trim()] = spec[1] === "✔" ? "pass" : spec[1] === "✖" ? "fail" : "skip";
    }
  }
  // Suites report ok/not ok too; drop parents that have children.
  for (const key of Object.keys(tests)) {
    if (Object.keys(tests).some((other) => other.startsWith(`${key} > `))) delete tests[key];
  }
  const text = all.join("\n");
  const pass = /^# pass (\d+)/m.exec(text) ?? /^ℹ pass (\d+)/m.exec(text);
  const fail = /^# fail (\d+)/m.exec(text) ?? /^ℹ fail (\d+)/m.exec(text);
  const skip = /^# skip(?:ped)? (\d+)/m.exec(text) ?? /^ℹ skipped (\d+)/m.exec(text);
  return {
    tests,
    summary:
      pass || fail
        ? { passed: Number(pass?.[1] ?? 0), failed: Number(fail?.[1] ?? 0), skipped: Number(skip?.[1] ?? 0) }
        : null,
  };
};

/** vitest (default + verbose reporters) and jest. */
export const parseVitestJest: Parser = (output) => {
  const tests: Record<string, TestOutcome> = {};
  const all = lines(output);
  let file = "";
  for (const line of all) {
    const fileLine = /^\s*(PASS|FAIL)\s+(\S+\.(?:[cm]?[jt]sx?))\b/.exec(line);
    if (fileLine) {
      file = fileLine[2]!;
      continue;
    }
    // vitest "FAIL  tests/a.test.ts > suite > name"
    const vfail = /^\s*FAIL\s+(\S+) > (.+)$/.exec(line);
    if (vfail) {
      tests[`${vfail[1]} > ${vfail[2]!.trim()}`] = "fail";
      continue;
    }
    const mark = /^\s*(✓|√|✔|×|✕|✗|↓|○)\s+(.+?)(?:\s+\(?\d+\s*m?s\)?)?\s*$/.exec(line);
    if (!mark) continue;
    const name = mark[2]!.trim();
    // vitest file-level summary line: "✓ tests/a.test.ts (3 tests) 5ms"
    if (/\(\d+ tests?(?: \|[^)]*)?\)/.test(line) && /\.[cm]?[jt]sx?\b/.test(name)) continue;
    const id = file && !name.includes(" > ") ? `${file} > ${name}` : name;
    tests[id] = /[✓√✔]/.test(mark[1]!) ? "pass" : /[×✕✗]/.test(mark[1]!) ? "fail" : "skip";
  }
  const text = all.join("\n");
  const jest = /^Tests:\s+(.+)$/m.exec(text);
  const vitest = /^\s*Tests\s+(.+\(\d+\))\s*$/m.exec(text);
  const line = jest?.[1] ?? vitest?.[1];
  return {
    tests,
    summary: line ? countSummary(line, { passed: "passed", failed: "failed", skipped: "skipped", todo: "skipped" }) : null,
  };
};

const PARSERS: Partial<Record<TestFramework, Parser>> = {
  pytest: parsePytest,
  unittest: parseUnittest,
  go: parseGo,
  cargo: parseCargo,
  "node-test": parseNodeTest,
  vitest: parseVitestJest,
  jest: parseVitestJest,
};

/** Parse with the framework's parser; for ambiguous runners, the best of all. */
export function parseTestOutput(framework: TestFramework, output: string): ParsedTests {
  const direct = PARSERS[framework];
  if (direct) {
    const parsed = direct(output);
    if (Object.keys(parsed.tests).length || parsed.summary) return parsed;
  }
  let best: ParsedTests = { tests: {}, summary: null };
  for (const parser of [parsePytest, parseUnittest, parseNodeTest, parseVitestJest, parseGo, parseCargo]) {
    const parsed = parser(output);
    if (Object.keys(parsed.tests).length > Object.keys(best.tests).length) best = parsed;
    else if (!Object.keys(best.tests).length && !best.summary && parsed.summary) best = parsed;
  }
  return best;
}
