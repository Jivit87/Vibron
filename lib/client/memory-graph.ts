/**
 * Memory as a graph: notes from the `.viberon/vault`, overlaid on the code graph.
 *
 * `GET /api/memory/graph` and the `entries` / `vault` fields of
 * `GET /api/memory` are built in parallel with this client, so every reader
 * here is tolerant: unknown shapes collapse to empty, never throw.
 *
 *   GET /api/memory/graph?repoKey= → { nodes: { id, kind: "note" | "code", label, stale? }[], links: { source, target }[] }
 *   GET /api/memory?repoKey=       → { memory, entries: { id, kind, text, anchors, stale }[], vault?: { path, notes } }
 */

import type { Graph } from "@/lib/graph";
import { isMockMode } from "@/lib/client/mock-run";

export interface MemoryGraphNode {
  id: string;
  kind: "note" | "code";
  label: string;
  stale: boolean;
  /** Some producers inline the note body; otherwise it comes from `entries`. */
  text?: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  links: { source: string; target: string }[];
}

/** A graph-anchored memory entry (one vault note). */
export interface AnchoredEntry {
  id?: string;
  kind: string;
  text: string;
  anchors: string[];
  stale: boolean;
}

export interface VaultInfo {
  path: string;
  notes: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function endpoint(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value === "object") return str((value as { id?: unknown }).id);
  return undefined;
}

export function normalizeMemoryGraph(body: unknown): MemoryGraph {
  const b = (body ?? {}) as Record<string, unknown>;
  const inner = (b.graph && typeof b.graph === "object" ? b.graph : b) as Record<string, unknown>;
  const nodes: MemoryGraphNode[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(inner.nodes) ? inner.nodes : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = r.kind === "code" || id.startsWith("code/") ? "code" : "note";
    nodes.push({
      id,
      kind,
      label: str(r.label) ?? str(r.title) ?? id.split("/").pop() ?? id,
      stale: r.stale === true,
      text: str(r.text) ?? str(r.body),
    });
  }
  const links: MemoryGraph["links"] = [];
  const rawLinks = Array.isArray(inner.links) ? inner.links : Array.isArray(inner.edges) ? inner.edges : [];
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const source = endpoint(r.source);
    const target = endpoint(r.target);
    if (source && target && source !== target) links.push({ source, target });
  }
  return { nodes, links };
}

export function parseAnchored(raw: unknown): AnchoredEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AnchoredEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.text !== "string" || !Array.isArray(r.anchors)) continue;
    out.push({
      id: str(r.id),
      kind: str(r.kind) ?? "fact",
      text: r.text,
      anchors: r.anchors.filter((a): a is string => typeof a === "string"),
      stale: r.stale === true,
    });
  }
  return out;
}

export function parseVault(raw: unknown): VaultInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const path = str(r.path);
  if (!path) return null;
  const notes = Array.isArray(r.notes) ? r.notes.length : typeof r.notes === "number" ? r.notes : 0;
  return { path, notes };
}

/** `obsidian://open?path=…` for an absolute vault path. */
export function obsidianUrl(absPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absPath)}`;
}

/** `code/src/a.ts.md`, `[[code/src/a.ts]]` or `src/a.ts` → `src/a.ts`. */
export function codeRefPath(ref: string): string {
  return ref
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/^code\//, "")
    .replace(/\.md$/, "")
    .replace(/^\.?\//, "");
}

/**
 * Render ids a code reference lands on in the current (aggregated) view.
 * A reference is a graph symbol id, or a file path; a file path maps to every
 * symbol in that file, which collapses to its folder bubble when collapsed.
 */
export function resolveCodeRef(
  ref: string,
  graph: Pick<Graph, "nodes">,
  symbolToRenderId: ReadonlyMap<string, string>,
): string[] {
  const direct = symbolToRenderId.get(ref);
  if (direct) return [direct];
  const path = codeRefPath(ref);
  const [file, symbol] = path.split(/#|::/);
  const out = new Set<string>();
  for (const node of graph.nodes) {
    if (node.file !== file) continue;
    if (symbol && node.name !== symbol) continue;
    const id = symbolToRenderId.get(node.id);
    if (id) out.add(id);
  }
  return [...out];
}

export interface NoteOverlayNode {
  /** Render id: `note:<memory id>`. */
  id: string;
  noteId: string;
  label: string;
  stale: boolean;
  text?: string;
}

export interface MemoryOverlay {
  notes: NoteOverlayNode[];
  links: { source: string; target: string }[];
}

export const NOTE_PREFIX = "note:";

/**
 * Overlay memory notes onto the render graph: note nodes, note → code links
 * resolved against the current view, and note → note links. Code nodes that
 * match nothing in the view are dropped; notes are always kept.
 */
export function overlayMemory(
  mem: MemoryGraph,
  graph: Pick<Graph, "nodes">,
  symbolToRenderId: ReadonlyMap<string, string>,
): MemoryOverlay {
  const notes: NoteOverlayNode[] = mem.nodes
    .filter((n) => n.kind === "note")
    .map((n) => ({ id: NOTE_PREFIX + n.id, noteId: n.id, label: n.label, stale: n.stale, text: n.text }));
  const noteIds = new Set(mem.nodes.filter((n) => n.kind === "note").map((n) => n.id));
  const links: MemoryOverlay["links"] = [];
  const seen = new Set<string>();
  const push = (source: string, target: string) => {
    const key = `${source}\u0000${target}`;
    if (seen.has(key) || source === target) return;
    seen.add(key);
    links.push({ source, target });
  };
  for (const link of mem.links) {
    // Links may point either way; normalize to note → other.
    const [note, other] = noteIds.has(link.source)
      ? [link.source, link.target]
      : noteIds.has(link.target)
        ? [link.target, link.source]
        : [null, null];
    if (!note || !other) continue;
    if (noteIds.has(other)) {
      if (note < other) push(NOTE_PREFIX + note, NOTE_PREFIX + other);
      continue;
    }
    for (const target of resolveCodeRef(other, graph, symbolToRenderId)) push(NOTE_PREFIX + note, target);
  }
  return { notes, links };
}

/** Find a note's entry: by id, by `notes/<id>`, or by its label. */
export function entryForNote(entries: readonly AnchoredEntry[], note: { noteId: string; label: string }): AnchoredEntry | undefined {
  const bare = note.noteId.replace(/^notes\//, "").replace(/\.md$/, "");
  return (
    entries.find((e) => e.id && (e.id === note.noteId || e.id === bare)) ??
    entries.find((e) => e.text.startsWith(note.label))
  );
}

/**
 * Backlinks: notes anchored to the selected file or symbol. An anchor matches
 * the symbol id, the file path (bare or as `code/<path>`), or any symbol id
 * that lives in the file.
 */
export function backlinksFor(
  entries: readonly AnchoredEntry[],
  selection: { file?: string | null; symbolId?: string | null },
  graph: Pick<Graph, "nodes"> | null,
): AnchoredEntry[] {
  const { file, symbolId } = selection;
  if (!file && !symbolId) return [];
  const symbolFile = symbolId ? graph?.nodes.find((n) => n.id === symbolId)?.file : undefined;
  const files = new Set([file, symbolFile].filter((f): f is string => Boolean(f)));
  const fileOf = new Map<string, string>();
  for (const n of graph?.nodes ?? []) fileOf.set(n.id, n.file);
  return entries.filter((e) =>
    e.anchors.some((a) => {
      if (symbolId && a === symbolId) return true;
      const anchorFile = fileOf.get(a) ?? codeRefPath(a).split(/#|::/)[0];
      return files.has(anchorFile);
    }),
  );
}

/* ------------------------------- fetching -------------------------------- */

export async function fetchMemoryGraph(repoKey: string, graph: Graph | null, rootPath?: string): Promise<MemoryGraph> {
  if (isMockMode()) return mockMemory(graph, rootPath).graph;
  const response = await fetch(`/api/memory/graph?repoKey=${encodeURIComponent(repoKey)}`);
  if (!response.ok) return { nodes: [], links: [] };
  return normalizeMemoryGraph(await response.json().catch(() => null));
}

/** Entries and vault from `GET /api/memory` (the body's other fields are the caller's). */
export function readMemoryIndex(
  body: unknown,
  mock?: { graph: Graph | null; rootPath?: string },
): { entries: AnchoredEntry[]; vault: VaultInfo | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const memory = (b.memory ?? {}) as Record<string, unknown>;
  const entries = parseAnchored(b.entries ?? memory.entries);
  const vault = parseVault(b.vault ?? memory.vault);
  if (mock && isMockMode() && entries.length === 0) {
    const m = mockMemory(mock.graph, mock.rootPath);
    return { entries: m.entries, vault: vault ?? m.vault };
  }
  return { entries, vault };
}

/* --------------------------------- mock ---------------------------------- */

/**
 * `?mock=1`: notes anchored to the busiest files of whatever graph is open,
 * so the overlay and backlinks are demoable without the memory backend.
 */
export function mockMemory(
  graph: Pick<Graph, "nodes"> | null,
  rootPath?: string,
): { graph: MemoryGraph; entries: AnchoredEntry[]; vault: VaultInfo } {
  const counts = new Map<string, number>();
  for (const n of graph?.nodes ?? []) counts.set(n.file, (counts.get(n.file) ?? 0) + 1);
  const files = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const [f1 = "src/index.ts", f2 = "src/lib/util.ts", f3 = "src/app.ts", f4 = "README.md"] = files;
  const name = (f: string) => f.split("/").pop() ?? f;
  const entries: AnchoredEntry[] = [
    {
      id: "fix-empty-input",
      kind: "fix",
      text: `Fix: empty input crashed ${name(f1)}. Root cause: the caller assumed a non-empty list. Verified by the repo's tests.`,
      anchors: [f1, f2],
      stale: false,
    },
    {
      id: "convention-errors",
      kind: "convention",
      text: `Errors from ${name(f2)} are returned as values, never thrown across module boundaries.`,
      anchors: [f2],
      stale: false,
    },
    {
      id: "fact-entry",
      kind: "fact",
      text: `${name(f3)} is the entry point; it wires configuration before anything else loads.`,
      anchors: [f3, f1],
      stale: false,
    },
    {
      id: "decision-cache",
      kind: "decision",
      text: `Results are cached per file in ${name(f4)}; the cache key changed since this was written.`,
      anchors: [f4],
      stale: true,
    },
  ];
  const nodes: MemoryGraphNode[] = [];
  const links: MemoryGraph["links"] = [];
  const code = new Set<string>();
  for (const e of entries) {
    const id = `notes/${e.id}`;
    nodes.push({ id, kind: "note", label: e.text.split(/[.:]/)[0].slice(0, 48), stale: e.stale, text: e.text });
    for (const a of e.anchors) {
      code.add(a);
      links.push({ source: id, target: `code/${a}` });
    }
  }
  links.push({ source: "notes/fix-empty-input", target: "notes/convention-errors" });
  for (const f of code) nodes.push({ id: `code/${f}`, kind: "code", label: name(f), stale: false });
  const base = (rootPath ?? "/tmp/viberon-demo").replace(/\/$/, "");
  return {
    graph: { nodes, links },
    entries: entries.map((e) => ({ ...e, id: `notes/${e.id}` })),
    vault: { path: `${base}/.viberon/vault`, notes: entries.length },
  };
}
