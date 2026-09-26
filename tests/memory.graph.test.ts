import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import {
  addEntry,
  clearMemoryGraphCache,
  getMemoryGraph,
  recordFixNote,
  relevantEntries,
  renderAnchoredEntries,
  setSummary,
  summaryFor,
} from "@/lib/memory";
import { getGraph, resetMemoryStoreForTests } from "@/lib/store";
import { openWorkspace, writeFile as wsWriteFile } from "@/lib/workspace";
import { clearGraphIndexCache } from "@/lib/workspace/graph-index";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-memgraph-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(
    path.join(root, "slug.py"),
    "def slugify(s):\n    return s.lower()\n\n\ndef other():\n    return 1\n",
  );
  await writeFile(path.join(root, "wrap.py"), "def wrap(s):\n    return s\n");
  const meta = await registerLocalWorkspace(root);
  const graph = (await getGraph(meta.repoKey))!;
  const id = (name: string) => graph.nodes.find((n) => n.name === name)!.id;
  return { root, meta, id };
}

describe("graph-anchored memory", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    clearGraphIndexCache();
    clearMemoryGraphCache();
  });

  it("anchors entries and summaries to nodes and marks them stale when code changes", async () => {
    const { root, meta, id } = await setup();
    const slugId = id("slugify");
    const entry = addEntry(root, { kind: "fact", text: "slugify lowercases only", anchors: [slugId] });
    expect(entry.anchors[0]).toMatchObject({ ref: slugId, path: "slug.py", name: "slugify" });
    setSummary(root, slugId, "Turns a title into a URL slug.");
    setSummary(root, "wrap.py", "Text wrapping helpers.");
    expect(summaryFor(root, slugId)).toEqual({ text: "Turns a title into a URL slug.", stale: false });
    expect(existsSync(path.join(root, ".viberon", "memory.json"))).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).not.toContain(".viberon");

    // Editing a *different* symbol in the same file (shifting lines) keeps it fresh.
    const handle = await openWorkspace(meta.repoKey);
    await wsWriteFile(
      handle,
      "slug.py",
      "import re\n\n\ndef slugify(s):\n    return s.lower()\n\n\ndef other():\n    return 2\n",
    );
    expect(summaryFor(root, slugId)?.stale).toBe(false);
    expect(getMemoryGraph(root).entries[0]!.stale).toBe(false);

    // Changing the anchored symbol itself makes it stale.
    await wsWriteFile(handle, "slug.py", "def slugify(s):\n    return re.sub('x', '-', s)\n");
    expect(summaryFor(root, slugId)?.stale).toBe(true);
    const graph = getMemoryGraph(root);
    expect(graph.entries[0]!.stale).toBe(true);
    expect(renderAnchoredEntries(graph.entries)).toContain("(may be outdated)");
    expect(summaryFor(root, "wrap.py")?.stale).toBe(false);

    // Persisted: a fresh process (cache cleared) sees the same memory.
    clearMemoryGraphCache();
    expect(getMemoryGraph(root).summaries["wrap.py"]!.text).toBe("Text wrapping helpers.");
  });

  it("ranks relevant entries and records runs for the next task on the same area", async () => {
    const { root, id } = await setup();
    addEntry(root, { kind: "convention", text: "wrap keeps whitespace", anchors: ["wrap.py"] });
    addEntry(root, { kind: "decision", text: "slugify must be ASCII", anchors: [id("slugify")] });
    addEntry(root, { kind: "decision", text: "slugify must be ASCII", anchors: [id("slugify")] });
    const run = recordFixNote(root, {
      issue: "slugify keeps accents\nlong body",
      files: ["slug.py"],
      rootCause: "no unicode normalization",
      verified: true,
    });
    expect(run.kind).toBe("fix");
    expect(getMemoryGraph(root).runs).toHaveLength(1);

    const relevant = relevantEntries(root, [id("slugify")], 5);
    expect(relevant.map((e) => e.text)).toEqual([
      "slugify must be ASCII",
      "Past fix (verified): slugify keeps accents — no unicode normalization",
      "wrap keeps whitespace",
    ]);
    expect(relevantEntries(root, ["wrap.py"], 1)[0]!.text).toBe("wrap keeps whitespace");
  });
});
