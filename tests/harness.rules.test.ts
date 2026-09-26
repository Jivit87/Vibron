import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadRules, parseMdcRule, RULES_TOKEN_CAP } from "@/lib/agents/rules";
import { resolveAttachments } from "@/lib/harness/attachments";
import type { WorkspaceHandle } from "@/lib/workspace";
import { makeWorkspace } from "./helpers/harness-workspace";

describe("loadRules", () => {
  it("loads every supported source in precedence order", async () => {
    const { handle } = await makeWorkspace([
      { path: "CLAUDE.md", source: "claude rules" },
      { path: "AGENTS.md", source: "agents rules" },
      { path: ".viberon/rules.md", source: "viberon rules" },
      { path: ".cursorrules", source: "cursor rules" },
      { path: ".cursor/rules/always.mdc", source: "---\ndescription: x\nalwaysApply: true\n---\nalways rule" },
      { path: ".cursor/rules/sometimes.mdc", source: "---\nglobs: src/**\nalwaysApply: false\n---\nscoped rule" },
      { path: "packages/web/AGENTS.md", source: "web rules" },
      { path: "src/app.ts", source: "export {}" },
    ]);
    const bundle = await loadRules(handle);
    expect(bundle.files.map((f) => [f.path, f.source])).toEqual([
      [".viberon/rules.md", "viberon"],
      ["AGENTS.md", "agents"],
      ["CLAUDE.md", "claude"],
      [".cursorrules", "cursor"],
      [".cursor/rules/always.mdc", "cursor"],
      ["packages/web/AGENTS.md", "agents"],
    ]);
    expect(bundle.text).toContain("always rule");
    expect(bundle.text).not.toContain("scoped rule");
    expect(bundle.text).toContain("applies to files under packages/web/");
  });

  it("caps the total at the token budget", async () => {
    const { handle } = await makeWorkspace([
      { path: "AGENTS.md", source: "word ".repeat(12_000) },
      { path: "CLAUDE.md", source: "never loaded" },
    ]);
    const bundle = await loadRules(handle);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0].tokens).toBeLessThanOrEqual(RULES_TOKEN_CAP + 20);
    expect(bundle.text).toContain("truncated");
  });

  it("reads dotfiles the disk scanner skips", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "viberon-rules-"));
    mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
    writeFileSync(path.join(root, ".cursorrules"), "disk cursor rules");
    writeFileSync(path.join(root, ".cursor", "rules", "a.mdc"), "---\nalwaysApply: true\n---\nmdc on disk");
    const handle: WorkspaceHandle = { repoKey: "disk-rules", rootPath: root, repoRef: "local", label: "x" };
    const bundle = await loadRules(handle);
    expect(bundle.files.map((f) => f.path)).toEqual([".cursorrules", ".cursor/rules/a.mdc"]);
  });

  it("parses mdc front matter", () => {
    expect(parseMdcRule("---\nalwaysApply: true\n---\nbody")).toEqual({ alwaysApply: true, body: "body" });
    expect(parseMdcRule("no front matter").alwaysApply).toBe(false);
  });
});

describe("resolveAttachments", () => {
  it("renders references and inline items into one block", async () => {
    const { handle } = await makeWorkspace([
      { path: "src/a.ts", source: "line1\nline2\nline3\n" },
      { path: "src/b.ts", source: "b" },
    ]);
    const block = await resolveAttachments(handle, [
      { kind: "file", path: "src/a.ts" },
      { kind: "folder", path: "src" },
      { kind: "symbol", name: "two", path: "src/a.ts", startLine: 2, endLine: 2 },
      { kind: "terminal", label: "dev", content: "error!" },
      { kind: "file", path: "missing.ts" },
    ]);
    expect(block.startsWith("## Attached context")).toBe(true);
    expect(block).toContain("### src/a.ts");
    expect(block).toContain("src/b.ts");
    expect(block).toMatch(/### two \(src\/a\.ts:2-2\)\n\n```\nline2\n```/);
    expect(block).toContain("error!");
    expect(block).toContain("missing.ts\n\n(File not found.)");
    expect(await resolveAttachments(handle, [])).toBe("");
  });
});
