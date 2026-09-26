import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { globToRegExp, makeGlobFilter, ripgrep, searchFiles } from "@/lib/search";

const files = [
  { path: "src/a.ts", source: "const Foo = 1;\nfoo(bar);\n" },
  { path: "src/deep/b.tsx", source: "// é Foo here\n" },
  { path: "docs/readme.md", source: "Foo docs\n" },
];

describe("searchFiles (JS fallback)", () => {
  it("literal, case-insensitive by default", () => {
    const r = searchFiles(files, { query: "foo" });
    expect(r.matches.map((m) => `${m.path}:${m.line}:${m.col}`)).toEqual([
      "src/a.ts:1:7",
      "src/a.ts:2:1",
      "src/deep/b.tsx:1:6",
      "docs/readme.md:1:1",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("case-sensitive, regex, special chars literal", () => {
    expect(searchFiles(files, { query: "foo", caseSensitive: true }).matches).toHaveLength(1);
    expect(searchFiles(files, { query: "fo+\\(", regex: true }).matches).toHaveLength(1);
    expect(searchFiles(files, { query: "foo(" }).matches).toHaveLength(1);
    expect(() => searchFiles(files, { query: "(", regex: true })).toThrow(/Invalid/);
  });

  it("globs and truncation", () => {
    expect(searchFiles(files, { query: "foo", globs: ["*.ts"] }).matches.every((m) => m.path === "src/a.ts")).toBe(true);
    expect(searchFiles(files, { query: "foo", globs: ["!src/**"] }).matches.map((m) => m.path)).toEqual(["docs/readme.md"]);
    expect(searchFiles(files, { query: "foo", globs: ["*.{md,tsx}"] }).matches).toHaveLength(2);
    expect(searchFiles(files, { query: "foo", maxResults: 2 })).toMatchObject({ truncated: true });
  });

  it("glob helpers", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(makeGlobFilter(["deep"])("src/deep/b.tsx")).toBe(true);
  });
});

const hasRg = spawnSync("rg", ["--version"]).status === 0;

describe.runIf(hasRg)("ripgrep", () => {
  it("matches the JS contract, and treats a dash query as a pattern", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vb-search-"));
    await mkdir(path.join(root, "src/deep"), { recursive: true });
    for (const f of files) {
      await mkdir(path.dirname(path.join(root, f.path)), { recursive: true });
      await writeFile(path.join(root, f.path), f.source);
    }
    const r = await ripgrep(root, { query: "foo" });
    expect(r!.matches.map((m) => `${m.path}:${m.line}:${m.col}`).sort()).toEqual(
      searchFiles(files, { query: "foo" }).matches.map((m) => `${m.path}:${m.line}:${m.col}`).sort(),
    );
    expect((await ripgrep(root, { query: "--files" }))!.matches).toEqual([]);
  });
});
