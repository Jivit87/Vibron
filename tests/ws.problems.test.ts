import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cachedProblems, runChecks } from "@/lib/problems";
import { parseEslintJson, parseTscOutput } from "@/lib/problems/parse";

/**
 * A fake workspace whose "typescript" and "eslint" are tiny node scripts
 * printing canned output — exercises the real spawn/parse/cache path without
 * installing anything.
 */
async function fakeWorkspace(opts: { tscDelayMs?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vb-problems-"));
  await writeFile(path.join(root, "tsconfig.json"), "{}");
  await writeFile(path.join(root, "eslint.config.js"), "export default [];");
  await mkdir(path.join(root, "node_modules/typescript/bin"), { recursive: true });
  await mkdir(path.join(root, "node_modules/eslint/bin"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/typescript/bin/tsc"),
    `const fs = require("fs");
     const n = Number(fs.existsSync("count") ? fs.readFileSync("count", "utf8") : 0) + 1;
     fs.writeFileSync("count", String(n));
     setTimeout(() => {
       console.log("src/a.ts(1,5): error TS2322: Type 'string' is not assignable.");
       console.log("src/b.ts(2,1): error TS1005: ';' expected.");
       process.exit(2);
     }, ${opts.tscDelayMs ?? 0});`,
  );
  await writeFile(
    path.join(root, "node_modules/eslint/bin/eslint.js"),
    `const files = process.argv.slice(2).filter((a) => a.startsWith("./") || a === ".");
     fs = require("fs"); fs.writeFileSync("eslint-args", JSON.stringify(process.argv.slice(2)));
     console.log(JSON.stringify(files.map((f) => ({
       filePath: require("path").resolve(f === "." ? "src/a.ts" : f),
       messages: [{ ruleId: "no-unused-vars", severity: 1, message: "unused", line: 3, column: 2 }],
     }))));`,
  );
  return root;
}

describe("runChecks", () => {
  it("runs both checkers, parses, and caches", async () => {
    const root = await fakeWorkspace();
    expect(cachedProblems(root).result).toBeNull();
    const result = await runChecks(root);
    expect(result.checkers.map((c) => [c.checker, c.ran])).toEqual([["tsc", true], ["eslint", true]]);
    expect(result.problems).toEqual([
      { file: "src/a.ts", line: 1, col: 5, severity: "error", code: "TS2322", message: "Type 'string' is not assignable.", source: "ts" },
      { file: "src/b.ts", line: 2, col: 1, severity: "error", code: "TS1005", message: "';' expected.", source: "ts" },
      { file: "src/a.ts", line: 3, col: 2, severity: "warning", code: "no-unused-vars", message: "unused", source: "eslint" },
    ]);
    expect(cachedProblems(root)).toEqual({ result, running: false });
  });

  it("filters by files, lints only those, and merges into the cache", async () => {
    const root = await fakeWorkspace();
    await runChecks(root);
    const focused = await runChecks(root, { files: ["src/b.ts", "../escape.ts", "README.md"] });
    expect(focused.problems.map((p) => p.file)).toEqual(["src/b.ts", "src/b.ts"]);
    const { readFile } = await import("node:fs/promises");
    const args = JSON.parse(await readFile(path.join(root, "eslint-args"), "utf8")) as string[];
    expect(args).toContain("./src/b.ts");
    expect(args).not.toContain(".");
    expect(args.some((a) => a.includes("escape"))).toBe(false);
    // Cache keeps src/a.ts problems from the full run.
    const cached = cachedProblems(root).result!;
    expect(cached.problems.filter((p) => p.file === "src/a.ts")).toHaveLength(2);
    expect(cached.problems.filter((p) => p.file === "src/b.ts")).toHaveLength(2);
  });

  it("is single-flight for concurrent identical requests", async () => {
    const root = await fakeWorkspace({ tscDelayMs: 300 });
    const a = runChecks(root);
    const b = runChecks(root);
    expect(a).toBe(b);
    expect(cachedProblems(root).running).toBe(true);
    await a;
    expect(cachedProblems(root).running).toBe(false);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(root, "count"), "utf8")).toBe("1");
  });

  it("times out a hung checker", async () => {
    const root = await fakeWorkspace({ tscDelayMs: 10_000 });
    const result = await runChecks(root, { timeoutMs: 1000 });
    expect(result.checkers[0].note).toBe("Timed out");
  });

  it("skips checkers that are not configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vb-problems-empty-"));
    const result = await runChecks(root);
    expect(result.checkers.map((c) => c.ran)).toEqual([false, false]);
    expect(result.problems).toEqual([]);
  });
});

describe("parsers", () => {
  it("tsc continuation lines and global errors", () => {
    const out = "/r/src/a.ts(1,1): error TS2322: Bad.\n  Detail line.\nerror TS5083: Cannot read file.\nFound 2 errors.";
    const problems = parseTscOutput(out, "/r");
    expect(problems[0]).toMatchObject({ file: "src/a.ts", message: "Bad.\nDetail line." });
    expect(problems[1]).toMatchObject({ file: "", code: "TS5083" });
  });

  it("eslint json with leading noise", () => {
    expect(parseEslintJson("warning: x\n[]", "/r")).toEqual([]);
    expect(parseEslintJson("garbage", "/r")).toEqual([]);
  });
});
