"use client";

/**
 * Project-wide search.
 *
 * Two modes over the same input, because a developer looking for something
 * wants both: literal text search across every file, and semantic search
 * over the symbol graph ("where do we validate sessions?").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CaseSensitive, Loader2, Regex, Search } from "lucide-react";

import { loadFile } from "@/lib/file-loader";
import { useViberon } from "@/store/viberon";
import {
  cx,
  EmptyState,
  PanelHeader,
  truncatePath,
} from "@/components/vibe/primitives";

interface TextMatch {
  path: string;
  line: number;
  text: string;
}

interface SymbolMatch {
  id: string;
  name: string;
  kind: string;
  file: string;
  startLine: number;
  signature: string;
}

export function SearchPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const graph = useViberon((s) => s.graph);
  const fileList = useViberon((s) => s.fileList);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"text" | "symbols">("text");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [textMatches, setTextMatches] = useState<TextMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function focus() {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("viberon:focusSearch", focus);
    return () => window.removeEventListener("viberon:focusSearch", focus);
  }, []);

  /**
   * Text search asks the server (`GET /api/search`, rg with a JS fallback).
   * Servers without that route get the old client-side scan, capped and run
   * with limited concurrency rather than hundreds of sequential fetches.
   */
  const runTextSearch = useCallback(
    async (needle: string) => {
      if (!needle.trim() || !repoKey) {
        setTextMatches([]);
        return;
      }
      setBusy(true);
      try {
        const params = new URLSearchParams({
          repoKey,
          q: needle,
          regex: regex ? "1" : "0",
          case: caseSensitive ? "1" : "0",
        });
        const server = await fetch(`/api/search?${params}`).catch(() => null);
        if (server?.ok) {
          const body = (await server.json()) as { matches?: { path: string; line: number; text: string }[] };
          setTextMatches(
            (body.matches ?? []).slice(0, 500).map((m) => ({ path: m.path, line: m.line, text: m.text.trim().slice(0, 180) })),
          );
          return;
        }
        let matcher: (line: string) => boolean;
        if (regex) {
          try {
            const re = new RegExp(needle, caseSensitive ? "" : "i");
            matcher = (line) => re.test(line);
          } catch {
            setTextMatches([]);
            return;
          }
        } else {
          const target = caseSensitive ? needle : needle.toLowerCase();
          matcher = (line) =>
            (caseSensitive ? line : line.toLowerCase()).includes(target);
        }

        const results: TextMatch[] = [];
        const queue = fileList.slice(0, 400);
        // Eight fetches in flight; a huge workspace cannot lock the UI.
        const worker = async () => {
          for (;;) {
            const path = queue.shift();
            if (!path || results.length >= 200) return;
            const response = await fetch(`/api/repos/files/${repoKey}?path=${encodeURIComponent(path)}`).catch(() => null);
            if (!response?.ok) continue;
            const body = (await response.json()) as { source?: string };
            if (!body.source) continue;
            const lines = body.source.split("\n");
            for (let i = 0; i < lines.length && results.length < 200; i += 1) {
              if (matcher(lines[i])) results.push({ path, line: i + 1, text: lines[i].trim().slice(0, 180) });
            }
          }
        };
        await Promise.all(Array.from({ length: 8 }, worker));
        results.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
        setTextMatches(results);
      } finally {
        setBusy(false);
      }
    },
    [repoKey, fileList, regex, caseSensitive],
  );

  // Symbol search is instant — the graph is already in memory.
  const symbolMatches: SymbolMatch[] = (() => {
    if (mode !== "symbols" || !graph || !query.trim()) return [];
    const needle = query.trim().toLowerCase();
    return graph.nodes
      .filter(
        (node) =>
          node.name.toLowerCase().includes(needle) ||
          node.signature.toLowerCase().includes(needle) ||
          node.file.toLowerCase().includes(needle),
      )
      .slice(0, 150)
      .map((node) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        file: node.file,
        startLine: node.startLine,
        signature: node.signature,
      }));
  })();

  const grouped = (() => {
    const map = new Map<string, TextMatch[]>();
    for (const match of textMatches) {
      const list = map.get(match.path) ?? [];
      list.push(match);
      map.set(match.path, list);
    }
    return [...map.entries()];
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Search" icon={<Search className="size-3" />} />

      <div className="flex shrink-0 flex-col gap-1.5 px-2 py-2">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "text") void runTextSearch(query);
          }}
          className="flex items-center gap-1.5 rounded-[4px] border px-2 py-1"
          style={{
            borderColor: "var(--vb-line-faint)",
            background: "var(--vb-bg-input)",
          }}
        >
          <Search className="size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === "text" ? "Find in files" : "Find a symbol"}
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: "var(--vb-text-hi)" }}
          />
          {busy && <Loader2 className="size-3 animate-spin" style={{ color: "var(--vb-accent)" }} />}
        </form>

        <div className="flex items-center gap-1">
          <div
            className="flex items-center gap-px rounded-[4px] border p-px"
            style={{ borderColor: "var(--vb-line-faint)" }}
          >
            <ModeButton
              active={mode === "text"}
              onClick={() => setMode("text")}
              icon={null}
              label="Text"
            />
            <ModeButton
              active={mode === "symbols"}
              onClick={() => setMode("symbols")}
              icon={null}
              label="Symbols"
            />
          </div>

          {mode === "text" && (
            <>
              <Toggle
                active={regex}
                onClick={() => setRegex((v) => !v)}
                title="Regular expression"
              >
                <Regex className="size-3.5" />
              </Toggle>
              <Toggle
                active={caseSensitive}
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match case"
              >
                <CaseSensitive className="size-3.5" />
              </Toggle>
              <button
                type="button"
                onClick={() => void runTextSearch(query)}
                disabled={!query.trim() || busy}
                className="vb-btn ml-auto"
              >
                Search
              </button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {mode === "symbols" ? (
          symbolMatches.length === 0 ? (
            <EmptyState
              title={query.trim() ? "No symbols match" : "Search the graph"}
              body={
                query.trim()
                  ? undefined
                  : "Type a name, a signature fragment, or a path. Results are instant — the graph is already loaded."
              }
            />
          ) : (
            <div className="flex flex-col">
              {symbolMatches.map((symbol) => (
                <button
                  key={symbol.id}
                  type="button"
                  onClick={() => {
                    useViberon.getState().selectNode(symbol.id);
                    void loadFile(repoKey, symbol.file);
                  }}
                  className="flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-[var(--vb-hover)]"
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="text-[11.5px] font-medium"
                      style={{ color: "var(--vb-text-hi)" }}
                    >
                      {symbol.name}
                    </span>
                    <span
                      className="rounded px-1 text-[11px] uppercase tracking-wider"
                      style={{
                        background: "var(--vb-fill)",
                        color: "var(--vb-text-faint)",
                      }}
                    >
                      {symbol.kind}
                    </span>
                  </span>
                  <span
                    className="truncate font-mono text-[11px]"
                    style={{ color: "var(--vb-text-faint)" }}
                  >
                    {truncatePath(symbol.file, 38)}:{symbol.startLine}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : grouped.length === 0 ? (
          <EmptyState
            title={query.trim() ? "No matches" : "Find in files"}
            body={
              query.trim()
                ? "Nothing matched. Try a shorter fragment or turn off case matching."
                : "Search the literal contents of every file in the workspace."
            }
          />
        ) : (
          <div className="flex flex-col gap-1">
            <p
              className="px-2 py-1 text-[11px]"
              style={{ color: "var(--vb-text-faint)" }}
            >
              {textMatches.length} match{textMatches.length === 1 ? "" : "es"} in{" "}
              {grouped.length} file{grouped.length === 1 ? "" : "s"}
            </p>
            {grouped.map(([path, matches]) => (
              <div key={path}>
                <button
                  type="button"
                  onClick={() => void loadFile(repoKey, path)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left transition-colors hover:bg-[var(--vb-hover)]"
                >
                  <span
                    className="truncate font-mono text-[11px]"
                    style={{ color: "var(--vb-text)" }}
                  >
                    {truncatePath(path, 34)}
                  </span>
                  <span
                    className="ml-auto shrink-0 font-mono text-[11px]"
                    style={{ color: "var(--vb-text-faint)" }}
                  >
                    {matches.length}
                  </span>
                </button>
                {matches.slice(0, 8).map((match, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => void loadFile(repoKey, match.path)}
                    className="flex w-full items-start gap-2 rounded py-0.5 pl-5 pr-2 text-left transition-colors hover:bg-[var(--vb-hover)]"
                  >
                    <span
                      className="shrink-0 font-mono text-[11px] tabular-nums"
                      style={{ color: "var(--vb-text-faint)" }}
                    >
                      {match.line}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px]"
                      style={{ color: "var(--vb-text-dim)" }}
                    >
                      {match.text}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex h-[20px] items-center gap-1 rounded-[2px] px-2 text-[11.5px]",
        !active && "hover:bg-[var(--vb-hover)]",
      )}
      style={
        active
          ? { background: "var(--vb-active)", color: "var(--vb-text-hi)" }
          : { color: "var(--vb-text-dim)" }
      }
    >
      {icon}
      {label}
    </button>
  );
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className="inline-flex size-6 items-center justify-center rounded-[3px] transition-colors hover:bg-[var(--vb-hover)]"
      style={{
        background: active ? "var(--vb-active)" : undefined,
        color: active ? "var(--vb-text-hi)" : "var(--vb-text-dim)",
      }}
    >
      {children}
    </button>
  );
}

export default SearchPanel;
