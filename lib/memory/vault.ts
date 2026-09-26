/**
 * The anchored memory graph (`lib/memory/graph.ts`), rendered as an Obsidian
 * vault at `<root>/.viberon/vault/`:
 *
 *   index.md             every note, grouped by kind
 *   notes/<slug>.md      one per entry: frontmatter {id, kind, anchors, stale,
 *                        created, updated}, the text, and wikilinks to the
 *                        code it is anchored to and to notes on the same code
 *   code/<path>.md       one stub per anchored file: its symbols + backlinks
 *
 * `memory.json` stays canonical; this module only renders it and reads human
 * edits back (graph.ts applies them). Note mtimes are pinned to the entry's
 * `updated` time, so a note edited in Obsidian is simply one whose mtime is
 * newer. Pure file I/O: it does not import the memory graph.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

export const VAULT_DIR = ".viberon/vault";

/** The slice of an anchored entry the vault needs. */
export interface VaultEntry {
  id: string;
  kind: string;
  text: string;
  anchors: { ref: string; path: string; name?: string }[];
  stale: boolean;
  createdAt: number;
  updatedAt?: number;
  slug?: string;
}

export interface VaultNote {
  slug: string;
  mtimeMs: number;
  id?: string;
  kind?: string;
  /** Frontmatter anchors plus `[[code/…]]` links in the body. */
  anchors: string[];
  text: string;
}

export interface VaultGraph {
  nodes: { id: string; kind: "note" | "code"; label: string; stale?: boolean }[];
  links: { source: string; target: string }[];
}

export function vaultPath(root: string): string {
  return path.join(root, VAULT_DIR);
}

export function updatedOf(entry: VaultEntry): number {
  return entry.updatedAt ?? entry.createdAt;
}

function slugify(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 7)
      .join("-") || "note"
  );
}

/** Give entries without a slug a stable, unique one (mutates). */
export function assignSlugs(entries: VaultEntry[]): void {
  const taken = new Set(entries.map((e) => e.slug).filter(Boolean));
  for (const entry of entries) {
    if (entry.slug) continue;
    const base = `${entry.kind}-${slugify(entry.text.split("\n")[0].replace(/^Past fix \((un)?verified\):\s*/, ""))}`;
    let slug = base;
    for (let i = 2; taken.has(slug); i += 1) slug = `${base}-${i}`;
    entry.slug = slug;
    taken.add(slug);
  }
}

function titleOf(entry: VaultEntry): string {
  return entry.text.split("\n")[0].slice(0, 120).replace(/[[\]|#]/g, " ").trim() || entry.kind;
}

function filesOf(entry: VaultEntry): string[] {
  return [...new Set(entry.anchors.map((a) => a.path).filter(Boolean))];
}

function renderNote(entry: VaultEntry, related: VaultEntry[]): string {
  const links = [
    ...entry.anchors
      .filter((a) => a.path)
      .map((a) => `- [[code/${a.path}]]${a.name ? ` · \`${a.name}\`` : ""}`),
    ...related.map((r) => `- [[notes/${r.slug}]]`),
  ];
  return [
    "---",
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `anchors: ${JSON.stringify(entry.anchors.map((a) => a.ref))}`,
    `stale: ${entry.stale}`,
    `created: ${new Date(entry.createdAt).toISOString()}`,
    `updated: ${new Date(updatedOf(entry)).toISOString()}`,
    "---",
    entry.text,
    "",
    ...(links.length ? ["## Links", "", ...new Set(links), ""] : []),
  ].join("\n");
}

/**
 * Write the vault. `symbolsFor(path)` lists a file's symbols for its code
 * stub. Notes of deleted entries are removed; hand-written notes that were
 * never imported (no `id`) are left alone.
 */
export function renderVault(root: string, entries: VaultEntry[], symbolsFor: (file: string) => string[] = () => []): void {
  const vault = vaultPath(root);
  const notesDir = path.join(vault, "notes");
  const codeDir = path.join(vault, "code");
  mkdirSync(notesDir, { recursive: true });
  rmSync(codeDir, { recursive: true, force: true });
  assignSlugs(entries);

  const byFile = new Map<string, VaultEntry[]>();
  for (const entry of entries) {
    for (const file of filesOf(entry)) byFile.set(file, [...(byFile.get(file) ?? []), entry]);
  }

  const live = new Set<string>();
  for (const entry of entries) {
    const related = new Set<VaultEntry>();
    for (const file of filesOf(entry)) for (const other of byFile.get(file) ?? []) if (other !== entry) related.add(other);
    const file = path.join(notesDir, `${entry.slug}.md`);
    live.add(`${entry.slug}.md`);
    writeFileSync(file, renderNote(entry, [...related].slice(0, 6)));
    const when = new Date(updatedOf(entry));
    utimesSync(file, when, when);
  }
  for (const name of readdirSync(notesDir)) {
    if (name.endsWith(".md") && !live.has(name) && parseNote(path.join(notesDir, name))?.id) {
      rmSync(path.join(notesDir, name), { force: true });
    }
  }

  for (const [file, notes] of byFile) {
    const stub = path.join(codeDir, `${file}.md`);
    mkdirSync(path.dirname(stub), { recursive: true });
    const symbols = symbolsFor(file);
    writeFileSync(
      stub,
      [
        `# ${file}`,
        "",
        ...(symbols.length ? ["## Symbols", "", ...symbols.slice(0, 80).map((s) => `- \`${s}\``), ""] : []),
        "## Notes",
        "",
        ...notes.map((n) => `- [[notes/${n.slug}|${titleOf(n)}]]${n.stale ? " (may be outdated)" : ""}`),
        "",
      ].join("\n"),
    );
  }

  const index = ["# Viberon memory", "", "What the agents and you learned about this repository. Edit any note, or add one under `notes/`; Viberon imports it.", ""];
  for (const kind of [...new Set(entries.map((e) => e.kind))].sort()) {
    index.push(`## ${kind}`, "");
    for (const e of entries.filter((x) => x.kind === kind)) {
      index.push(`- [[notes/${e.slug}|${titleOf(e)}]]${e.stale ? " (may be outdated)" : ""}`);
    }
    index.push("");
  }
  if (byFile.size) index.push("## Code", "", ...[...byFile.keys()].sort().map((f) => `- [[code/${f}]]`), "");
  writeFileSync(path.join(vault, "index.md"), index.join("\n"));
}

function parseNote(file: string): Omit<VaultNote, "slug" | "mtimeMs"> | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const meta: Record<string, string> = {};
  let body = raw;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2].trim();
    }
    body = raw.slice(fm[0].length);
  }
  const [main] = body.split(/^## Links\s*$/m);
  const text = main.trim().replace(/^# (.+)$/m, "$1");
  let anchors: string[] = [];
  if (meta.anchors) {
    try {
      const parsed = JSON.parse(meta.anchors) as unknown;
      if (Array.isArray(parsed)) anchors = parsed.filter((a): a is string => typeof a === "string");
    } catch {
      anchors = meta.anchors.replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  const links = [...body.matchAll(/\[\[code\/([^\]|#]+?)(?:\.md)?(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim());
  return { id: meta.id, kind: meta.kind, anchors: [...new Set([...anchors, ...links])], text };
}

/** Every note in the vault with its mtime (graph.ts decides what changed). */
export function readVaultNotes(root: string): VaultNote[] {
  const notesDir = path.join(vaultPath(root), "notes");
  let names: string[];
  try {
    names = readdirSync(notesDir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: VaultNote[] = [];
  for (const name of names) {
    const file = path.join(notesDir, name);
    const note = parseNote(file);
    if (!note?.text) continue;
    out.push({ ...note, slug: name.slice(0, -3), mtimeMs: statSync(file).mtimeMs });
  }
  return out;
}

/** Notes linked to the code they are anchored to; ids are vault paths, as in Obsidian. */
export function vaultGraphOf(entries: VaultEntry[]): VaultGraph {
  assignSlugs(entries);
  const nodes: VaultGraph["nodes"] = [];
  const links: VaultGraph["links"] = [];
  const code = new Set<string>();
  for (const entry of entries) {
    const id = `notes/${entry.slug}`;
    nodes.push({ id, kind: "note", label: titleOf(entry), stale: entry.stale });
    for (const file of filesOf(entry)) {
      code.add(file);
      links.push({ source: id, target: `code/${file}` });
    }
  }
  for (const file of [...code].sort()) nodes.push({ id: `code/${file}`, kind: "code", label: file });
  return { nodes, links };
}
