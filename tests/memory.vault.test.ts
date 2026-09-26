import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as graphGet } from "@/app/api/memory/graph/route";
import { GET as memoryGet } from "@/app/api/memory/route";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import {
  addEntry,
  clearMemoryGraphCache,
  getMemoryGraph,
  recordFixNote,
  relevantLessons,
  removeEntry,
  vaultGraph,
} from "@/lib/memory";
import { resetMemoryStoreForTests } from "@/lib/store";
import { clearGraphIndexCache } from "@/lib/workspace/graph-index";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-vault-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "slug.py"), "def slugify(s):\n    return s.lower()\n\n\nclass Slugger:\n    def run(self):\n        return slugify('x')\n");
  await writeFile(path.join(root, "wrap.py"), "def wrap(s):\n    return s\n");
  const meta = await registerLocalWorkspace(root);
  return { root, repoKey: meta.repoKey, vault: path.join(root, ".viberon", "vault") };
}

const notes = (vault: string) => readdirSync(path.join(vault, "notes")).filter((n) => n.endsWith(".md"));

/** Simulate an edit made in Obsidian after the note was rendered. */
function editNote(file: string, text: string) {
  writeFileSync(file, text);
  const later = new Date(Date.now() + 5_000);
  utimesSync(file, later, later);
}

describe("memory vault", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    clearGraphIndexCache();
    clearMemoryGraphCache();
  });

  it("renders index, notes with frontmatter and wikilinks, and code stubs after a write", async () => {
    const { root, vault } = await setup();
    const a = addEntry(root, { kind: "decision", text: "slugify must stay ASCII", anchors: ["slug.py"] });
    addEntry(root, { kind: "fact", text: "Slugger wraps slugify", anchors: ["slug.py"] });

    const [first] = notes(vault).filter((n) => n.startsWith("decision-"));
    expect(first).toBe("decision-slugify-must-stay-ascii.md");
    const note = readFileSync(path.join(vault, "notes", first!), "utf8");
    expect(note).toMatch(/^---\nid: dec_\w+\nkind: decision\nanchors: \["slug.py"\]\nstale: false\ncreated: .+\nupdated: .+\n---\n/);
    expect(note).toContain("slugify must stay ASCII");
    expect(note).toContain("[[code/slug.py]]");
    expect(note).toContain("[[notes/fact-slugger-wraps-slugify]]");

    const stub = readFileSync(path.join(vault, "code", "slug.py.md"), "utf8");
    expect(stub).toContain("`slugify`");
    expect(stub).toContain("[[notes/decision-slugify-must-stay-ascii|slugify must stay ASCII]]");
    expect(readFileSync(path.join(vault, "index.md"), "utf8")).toContain("## decision");

    // The slug is stable and persisted with the entry.
    expect(getMemoryGraph(root).entries.find((e) => e.id === a.id)!.slug).toBe("decision-slugify-must-stay-ascii");
    // .viberon/ is excluded from git, so the vault never shows up in a diff.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).not.toContain(".viberon");
  });

  it("imports a note edited in the vault and a new hand-written note", async () => {
    const { root, vault } = await setup();
    const entry = addEntry(root, { kind: "fact", text: "wrap is a no-op", anchors: ["wrap.py"] });
    const file = path.join(vault, "notes", notes(vault)[0]!);
    editNote(file, readFileSync(file, "utf8").replace("wrap is a no-op", "wrap is a no-op until #12 lands"));
    writeFileSync(
      path.join(vault, "notes", "my-idea.md"),
      "# Cache slugs\n\nslugify is hot in [[code/slug.py]]; memoize it.\n",
    );

    clearMemoryGraphCache();
    const graph = getMemoryGraph(root);
    expect(graph.entries.find((e) => e.id === entry.id)!.text).toBe("wrap is a no-op until #12 lands");
    const added = graph.entries.find((e) => e.slug === "my-idea")!;
    expect(added).toMatchObject({ kind: "note", stale: false });
    expect(added.text).toContain("memoize it");
    expect(added.anchors.map((a) => a.ref)).toEqual(["slug.py"]);
    // The imported note is rendered back with frontmatter (its id now known).
    expect(readFileSync(path.join(vault, "notes", "my-idea.md"), "utf8")).toMatch(/^---\nid: not_/);
    // A second read changes nothing.
    const before = JSON.stringify(getMemoryGraph(root).entries);
    expect(JSON.stringify(getMemoryGraph(root).entries)).toBe(before);
  });

  it("marks a note stale when its anchored code changes, and removes notes of deleted entries", async () => {
    const { root, vault } = await setup();
    const entry = addEntry(root, { kind: "fact", text: "wrap returns its input", anchors: ["wrap.py"] });
    await writeFile(path.join(root, "wrap.py"), "def wrap(s):\n    return s.strip()\n");
    expect(getMemoryGraph(root).entries[0]!.stale).toBe(true);
    expect(readFileSync(path.join(vault, "notes", `${entry.slug}.md`), "utf8")).toContain("stale: true");
    expect(vaultGraph(root).nodes.find((n) => n.kind === "note")!.stale).toBe(true);

    expect(removeEntry(root, entry.id)).toBe(true);
    expect(existsSync(path.join(vault, "notes", `${entry.slug}.md`))).toBe(false);
  });

  it("records fix notes and recalls them as lessons for the same area", async () => {
    const { root } = await setup();
    const note = recordFixNote(root, {
      issue: "slugify keeps accents\n\nlong body",
      rootCause: "no unicode normalization before the ASCII filter",
      files: ["slug.py"],
      verified: true,
    });
    expect(note.kind).toBe("fix");
    expect(note.text).toBe("Past fix (verified): slugify keeps accents — no unicode normalization before the ASCII filter");
    expect(relevantLessons(root, { files: ["slug.py"], task: "anything" })).toEqual([note.text]);
    expect(relevantLessons(root, { files: ["other/x.py"], task: "slugify drops accents after normalization" })).toHaveLength(1);
    expect(relevantLessons(root, { files: ["other/x.py"], task: "unrelated" })).toEqual([]);
  });

  it("serves entries, the vault path and the vault graph over the API", async () => {
    const { root, repoKey } = await setup();
    addEntry(root, { kind: "decision", text: "keep wrap pure", anchors: ["wrap.py"] });

    const body = (await (await memoryGet(new Request(`http://x/api/memory?repoKey=${repoKey}`))).json()) as {
      entries: { id: string; kind: string; text: string; anchors: string[]; stale: boolean }[];
      vault: { path: string; notes: number };
    };
    expect(body.entries).toEqual([expect.objectContaining({ kind: "decision", text: "keep wrap pure", anchors: ["wrap.py"], stale: false })]);
    expect(body.vault).toEqual({ path: path.join(root, ".viberon", "vault"), notes: 1 });

    const graph = (await (await graphGet(new Request(`http://x/api/memory/graph?repoKey=${repoKey}`))).json()) as {
      nodes: { id: string; kind: string }[];
      links: { source: string; target: string }[];
    };
    expect(graph.nodes).toEqual([
      { id: "notes/decision-keep-wrap-pure", kind: "note", label: "keep wrap pure", stale: false },
      { id: "code/wrap.py", kind: "code", label: "wrap.py" },
    ]);
    expect(graph.links).toEqual([{ source: "notes/decision-keep-wrap-pure", target: "code/wrap.py" }]);
  });
});
