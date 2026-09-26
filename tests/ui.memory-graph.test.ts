import { describe, expect, it } from "vitest";

import {
  backlinksFor,
  codeRefPath,
  entryForNote,
  mockMemory,
  normalizeMemoryGraph,
  obsidianUrl,
  overlayMemory,
  parseAnchored,
  parseVault,
  readMemoryIndex,
  resolveCodeRef,
  type AnchoredEntry,
} from "@/lib/client/memory-graph";
import type { GraphNode } from "@/lib/graph";

function sym(id: string, file: string, name = id): GraphNode {
  return {
    id,
    kind: "function",
    name,
    file,
    folder: file.split("/")[0],
    loc: 3,
    signature: "",
    snippet: "",
    startLine: 1,
    endLine: 3,
  };
}

const graph = {
  nodes: [sym("s1", "src/a.ts", "alpha"), sym("s2", "src/a.ts", "beta"), sym("s3", "lib/b.ts", "gamma")],
};
// src/ is expanded (symbols render as themselves); lib/ is collapsed into a folder bubble.
const toRender = new Map([
  ["s1", "s1"],
  ["s2", "s2"],
  ["s3", "folder:lib"],
]);

describe("memory graph normalization", () => {
  it("reads nodes and links, tolerating edges, object endpoints and junk", () => {
    const g = normalizeMemoryGraph({
      graph: {
        nodes: [
          { id: "notes/n1", kind: "note", label: "Fix", stale: true },
          { id: "code/src/a.ts", label: "a.ts" },
          { id: "notes/n1", kind: "note", label: "dup" },
          { label: "no id" },
          null,
        ],
        edges: [{ source: { id: "notes/n1" }, target: "code/src/a.ts" }, { source: "x" }, { source: "y", target: "y" }],
      },
    });
    expect(g.nodes).toEqual([
      { id: "notes/n1", kind: "note", label: "Fix", stale: true, text: undefined },
      { id: "code/src/a.ts", kind: "code", label: "a.ts", stale: false, text: undefined },
    ]);
    expect(g.links).toEqual([{ source: "notes/n1", target: "code/src/a.ts" }]);
    expect(normalizeMemoryGraph(null)).toEqual({ nodes: [], links: [] });
    expect(normalizeMemoryGraph("nope")).toEqual({ nodes: [], links: [] });
  });

  it("strips vault prefixes from code references", () => {
    expect(codeRefPath("code/src/a.ts.md")).toBe("src/a.ts");
    expect(codeRefPath("[[code/src/a.ts]]")).toBe("src/a.ts");
    expect(codeRefPath("./src/a.ts")).toBe("src/a.ts");
  });
});

describe("graph merge", () => {
  it("resolves symbol ids, file paths and file#symbol against the current view", () => {
    expect(resolveCodeRef("s3", graph, toRender)).toEqual(["folder:lib"]);
    expect(resolveCodeRef("code/src/a.ts", graph, toRender)).toEqual(["s1", "s2"]);
    expect(resolveCodeRef("src/a.ts#beta", graph, toRender)).toEqual(["s2"]);
    expect(resolveCodeRef("lib/b.ts", graph, toRender)).toEqual(["folder:lib"]);
    expect(resolveCodeRef("missing.ts", graph, toRender)).toEqual([]);
  });

  it("overlays notes with note→code and note→note links, dropping unknown code", () => {
    const overlay = overlayMemory(
      {
        nodes: [
          { id: "notes/n1", kind: "note", label: "One", stale: false },
          { id: "notes/n2", kind: "note", label: "Two", stale: true },
          { id: "code/src/a.ts", kind: "code", label: "a.ts", stale: false },
        ],
        links: [
          { source: "notes/n1", target: "code/src/a.ts" },
          { source: "code/lib/b.ts", target: "notes/n1" },
          { source: "notes/n2", target: "notes/n1" },
          { source: "notes/n1", target: "notes/n2" },
          { source: "notes/n2", target: "code/gone.ts" },
          { source: "code/src/a.ts", target: "code/lib/b.ts" },
        ],
      },
      graph,
      toRender,
    );
    expect(overlay.notes.map((n) => [n.id, n.stale])).toEqual([
      ["note:notes/n1", false],
      ["note:notes/n2", true],
    ]);
    expect(overlay.links).toEqual([
      { source: "note:notes/n1", target: "s1" },
      { source: "note:notes/n1", target: "s2" },
      { source: "note:notes/n1", target: "folder:lib" },
      { source: "note:notes/n1", target: "note:notes/n2" },
    ]);
  });

  it("dedupes links that collapse into the same folder bubble", () => {
    const overlay = overlayMemory(
      {
        nodes: [{ id: "n", kind: "note", label: "n", stale: false }],
        links: [
          { source: "n", target: "s3" },
          { source: "n", target: "lib/b.ts" },
        ],
      },
      graph,
      toRender,
    );
    expect(overlay.links).toEqual([{ source: "note:n", target: "folder:lib" }]);
  });
});

describe("backlinks", () => {
  const entries: AnchoredEntry[] = [
    { id: "e1", kind: "fix", text: "by symbol", anchors: ["s2"], stale: false },
    { id: "e2", kind: "fact", text: "by path", anchors: ["code/src/a.ts"], stale: true },
    { id: "e3", kind: "fact", text: "elsewhere", anchors: ["lib/b.ts"], stale: false },
    { id: "e4", kind: "fact", text: "by file#symbol", anchors: ["src/a.ts#alpha"], stale: false },
  ];

  it("finds notes anchored to the selected file, directly or through its symbols", () => {
    expect(backlinksFor(entries, { file: "src/a.ts" }, graph).map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
    expect(backlinksFor(entries, { file: "lib/b.ts" }, graph).map((e) => e.id)).toEqual(["e3"]);
  });

  it("finds notes for a selected symbol, including notes on its file", () => {
    expect(backlinksFor(entries, { symbolId: "s3" }, graph).map((e) => e.id)).toEqual(["e3"]);
    expect(backlinksFor(entries, { symbolId: "s2" }, graph).map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
  });

  it("returns nothing without a selection", () => {
    expect(backlinksFor(entries, {}, graph)).toEqual([]);
    expect(backlinksFor(entries, { file: null, symbolId: null }, null)).toEqual([]);
  });
});

describe("memory index", () => {
  it("parses entries and the vault, tolerating junk", () => {
    expect(parseAnchored([{ text: "a", anchors: ["x", 3] }, { text: 1 }, null])).toEqual([
      { id: undefined, kind: "fact", text: "a", anchors: ["x"], stale: false },
    ]);
    expect(parseVault({ path: "/r/.viberon/vault", notes: ["a", "b"] })).toEqual({ path: "/r/.viberon/vault", notes: 2 });
    expect(parseVault({ path: "" })).toBeNull();
    expect(readMemoryIndex({ memory: { entries: [{ text: "t", anchors: [] }] }, vault: { path: "/v", notes: 4 } })).toEqual({
      entries: [{ id: undefined, kind: "fact", text: "t", anchors: [], stale: false }],
      vault: { path: "/v", notes: 4 },
    });
    expect(readMemoryIndex(null)).toEqual({ entries: [], vault: null });
  });

  it("builds an Obsidian URL with the path encoded", () => {
    expect(obsidianUrl("/Users/me/my repo/.viberon/vault")).toBe(
      "obsidian://open?path=%2FUsers%2Fme%2Fmy%20repo%2F.viberon%2Fvault",
    );
  });

  it("matches a note to its entry by id, bare id or label", () => {
    const entries: AnchoredEntry[] = [
      { id: "abc", kind: "fix", text: "Fix: x", anchors: [], stale: false },
      { kind: "fact", text: "Label text and more", anchors: [], stale: false },
    ];
    expect(entryForNote(entries, { noteId: "notes/abc.md", label: "?" })?.id).toBe("abc");
    expect(entryForNote(entries, { noteId: "zzz", label: "Label text" })?.kind).toBe("fact");
  });

  it("mock memory anchors notes to the busiest files and overlays onto the graph", () => {
    const mock = mockMemory(graph, "/repo");
    expect(mock.vault.path).toBe("/repo/.viberon/vault");
    expect(mock.entries[0].anchors).toContain("src/a.ts");
    const overlay = overlayMemory(mock.graph, graph, toRender);
    expect(overlay.notes).toHaveLength(4);
    expect(overlay.links.some((l) => l.target === "s1")).toBe(true);
    expect(overlay.notes.filter((n) => n.stale)).toHaveLength(1);
  });
});
