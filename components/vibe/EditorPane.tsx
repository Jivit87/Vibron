"use client";

/**
 * The editor surface: tab strip plus whatever the active tab holds.
 *
 * Tabs are files (Monaco), Source Control diffs, or one of the synthetic
 * pages (Welcome, Settings, Review, Graph). Preview tabs (single-click opens)
 * are italic and get replaced by the next preview; editing or double-click
 * pins them. Agent writes land live in open tabs; a dirty tab is never
 * clobbered mid-typing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";

import { GraphPane } from "@/components/ide/GraphPane";
import { DiffView } from "@/components/vibe/DiffView";
import { ReviewView } from "@/components/vibe/ReviewView";
import { SettingsPage } from "@/components/vibe/SettingsPage";
import { WelcomeTab } from "@/components/vibe/WelcomeTab";
import { isMockMode, MOCK_GIT_SNAPSHOT } from "@/lib/client/mock-run";
import { defineViberonThemes, languageFor, monacoThemeName } from "@/lib/client/monaco-theme";
import { tabDescriptions } from "@/lib/editor/tabs";
import { loadFile, saveFile } from "@/lib/file-loader";
import type { GraphNode } from "@/lib/graph";
import { useProblems, type EditorDiagnostic } from "@/store/problems";
import { parseDiffTabPath, type DiffMode } from "@/store/scm";
import {
  GRAPH_TAB_PATH,
  isSyntheticTab,
  resolveTheme,
  REVIEW_TAB_PATH,
  SETTINGS_TAB_PATH,
  useViberon,
  WELCOME_TAB_PATH,
} from "@/store/viberon";
import { cx, Dot } from "@/components/vibe/primitives";

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="vb-shimmer m-3 h-4 w-40 rounded-[3px]" />,
});

export function EditorPane() {
  const tabs = useViberon((s) => s.tabs);
  const activeTabPath = useViberon((s) => s.activeTabPath);
  const graph = useViberon((s) => s.graph);
  const pulseIds = useViberon((s) => s.pulseIds);
  const selectedNodeId = useViberon((s) => s.selectedNodeId);
  const settings = useViberon((s) => s.settings);
  const repoKey = useViberon((s) => s.repoKey);
  const reveal = useProblems((s) => s.reveal);

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const path = activeTab?.path ?? WELCOME_TAB_PATH;
  const diff = parseDiffTabPath(path);
  const isFile = Boolean(activeTab) && !isSyntheticTab(path);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tabs opened without content (from SCM, Problems, the run view) load here.
  useEffect(() => {
    if (isFile && activeTab && activeTab.source === undefined && repoKey) {
      void loadFile(repoKey, activeTab.path);
    }
  }, [isFile, activeTab, repoKey]);

  const retrievedFiles = useMemo(() => {
    if (!graph || pulseIds.length === 0) return new Set<string>();
    const byId = new Map(graph.nodes.map((n) => [n.id, n.file] as const));
    const out = new Set<string>();
    for (const id of pulseIds) {
      const file = byId.get(id);
      if (file) out.add(file);
    }
    return out;
  }, [graph, pulseIds]);

  const pulsedInFile = useMemo<GraphNode[]>(() => {
    if (!graph || !isFile) return [];
    const set = new Set(pulseIds);
    return graph.nodes.filter((n) => set.has(n.id) && n.file === path);
  }, [graph, pulseIds, isFile, path]);

  const selectedNode = graph?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  // Graph decorations.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !isFile || typeof activeTab?.source !== "string") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decorations: any[] = [];
    if (selectedNode && selectedNode.file === path) {
      decorations.push({
        range: new monaco.Range(selectedNode.startLine, 1, selectedNode.endLine, 1),
        options: { isWholeLine: true, className: "viberon-selected-line", linesDecorationsClassName: "viberon-selected-gutter" },
      });
    }
    for (const node of pulsedInFile) {
      decorations.push({
        range: new monaco.Range(node.startLine, 1, node.endLine, 1),
        options: { isWholeLine: true, className: "viberon-retrieved-line", linesDecorationsClassName: "viberon-retrieved-gutter" },
      });
    }
    if (graph) {
      const inbound = new Map<string, number>();
      const outbound = new Map<string, number>();
      for (const edge of graph.edges) {
        outbound.set(edge.source, (outbound.get(edge.source) ?? 0) + 1);
        inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
      }
      for (const node of graph.nodes) {
        if (node.file !== path) continue;
        const inCount = inbound.get(node.id) ?? 0;
        const outCount = outbound.get(node.id) ?? 0;
        if (inCount === 0 && outCount === 0) continue;
        const parts: string[] = [];
        if (inCount) parts.push(`${inCount} incoming`);
        if (outCount) parts.push(`${outCount} outgoing`);
        decorations.push({
          range: new monaco.Range(node.startLine, 1, node.startLine, 1),
          options: {
            glyphMarginClassName:
              inCount && outCount ? "viberon-glyph-both" : inCount ? "viberon-glyph-in" : "viberon-glyph-out",
            glyphMarginHoverMessage: { value: `**${node.name}**: ${parts.join(", ")}` },
          },
        });
      }
    }
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, decorations);
    if (selectedNode && selectedNode.file === path) editor.revealLineInCenter(selectedNode.startLine, 0);
  }, [graph, selectedNode, pulsedInFile, activeTab, isFile, path]);

  // Jump requests from the Problems panel.
  useEffect(() => {
    const editor = editorRef.current;
    if (!reveal || !editor || reveal.path !== path || typeof activeTab?.source !== "string") return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: reveal.col });
    editor.focus();
    useProblems.getState().clearReveal();
  }, [reveal, path, activeTab?.source]);

  function scheduleSave(filePath: string, source: string) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    useViberon.getState().updateTabSource(filePath, source, true);
    saveTimerRef.current = setTimeout(() => {
      void saveFile(repoKey, filePath, source).then(() => {
        useViberon.getState().updateTabSource(filePath, source, false);
        useProblems.getState().scheduleRun(repoKey);
      });
    }, 500);
  }

  function saveNow() {
    const tab = useViberon.getState().tabs.find((t) => t.path === useViberon.getState().activeTabPath);
    if (!tab || typeof tab.source !== "string") return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void saveFile(repoKey, tab.path, tab.source).then(() => {
      useViberon.getState().updateTabSource(tab.path, tab.source ?? "", false);
    });
  }

  const monacoTheme = monacoThemeName(resolveTheme(settings.theme));

  let body: React.ReactNode;
  if (path === GRAPH_TAB_PATH) body = <GraphPane />;
  else if (path === SETTINGS_TAB_PATH) body = <SettingsPage />;
  else if (path === REVIEW_TAB_PATH) body = <ReviewView />;
  else if (diff) body = <ScmDiff mode={diff.mode} path={diff.path} />;
  else if (!activeTab || path === WELCOME_TAB_PATH) body = <WelcomeTab />;
  else if (typeof activeTab.source !== "string") {
    body = (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className="vb-shimmer h-3 rounded-[2px]" style={{ width: `${40 + ((i * 17) % 45)}%` }} />
        ))}
      </div>
    );
  } else {
    body = (
      <MonacoEditor
        height="100%"
        theme={monacoTheme}
        path={activeTab.path}
        language={languageFor(activeTab.path)}
        value={activeTab.source}
        beforeMount={(monaco) => defineViberonThemes(monaco)}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveNow());
        }}
        onValidate={(markers) => {
          const list: EditorDiagnostic[] = markers
            .filter((m) => m.severity >= 4)
            .map((m) => ({
              line: m.startLineNumber,
              col: m.startColumn,
              severity: m.severity >= 8 ? "error" : "warning",
              message: m.message,
              source: m.source || "editor",
            }));
          useProblems.getState().setDiagnostics(activeTab.path, list);
        }}
        onChange={(next) => {
          if (typeof next !== "string") return;
          scheduleSave(activeTab.path, next);
        }}
        options={{
          fontSize: settings.editorFontSize,
          fontLigatures: false,
          minimap: { enabled: settings.editorMinimap, scale: 1 },
          wordWrap: settings.editorWordWrap ? "on" : "off",
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          glyphMargin: true,
          folding: true,
          lineNumbersMinChars: 3,
          padding: { top: 8, bottom: 40 },
          cursorBlinking: "solid",
          automaticLayout: true,
          bracketPairColorization: { enabled: false },
          guides: { indentation: true, bracketPairs: false },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--vb-bg-base)" }}>
      <TabStrip retrievedFiles={retrievedFiles} />
      {isFile && <Breadcrumb path={path} />}
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <div
      className="flex h-[22px] shrink-0 items-center gap-1 overflow-hidden px-3 text-[11.5px]"
      style={{ color: "var(--vb-text-dim)" }}
    >
      {parts.map((part, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span style={{ color: "var(--vb-text-faint)" }}>/</span>}
          <span style={{ color: i === parts.length - 1 ? "var(--vb-text-mid)" : undefined }}>{part}</span>
        </span>
      ))}
    </div>
  );
}

/** Source Control diff tab: HEAD↔INDEX for staged, INDEX↔WORKING otherwise. */
function ScmDiff({ mode, path }: { mode: DiffMode; path: string }) {
  const repoKey = useViberon((s) => s.repoKey);
  const [sides, setSides] = useState<{ original: string; modified: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSides(null);
    setError(null);
    if (isMockMode()) {
      const exists = MOCK_GIT_SNAPSHOT.status?.files.some((f) => f.path === path);
      setSides({
        original: mode === "untracked" ? "" : `// ${path} at ${mode === "staged" ? "HEAD" : "INDEX"}\nexport const value = 1;\n`,
        modified: exists ? `// ${path}\nexport const value = 2;\nexport const added = true;\n` : "",
      });
      return;
    }
    const [left, right] = mode === "staged" ? ["HEAD", "INDEX"] : mode === "untracked" ? [null, "WORKING"] : ["INDEX", "WORKING"];
    const fetchSide = async (ref: string | null): Promise<string> => {
      if (!ref) return "";
      const response = await fetch(
        `/api/git?repoKey=${encodeURIComponent(repoKey)}&op=show&path=${encodeURIComponent(path)}&ref=${ref}`,
      );
      if (!response.ok) throw new Error(response.status === 404 ? "Diffs need the git API." : `HTTP ${response.status}`);
      const body = (await response.json()) as { content: string | null };
      return body.content ?? "";
    };
    Promise.all([fetchSide(left), fetchSide(right)])
      .then(([original, modified]) => !cancelled && setSides({ original, modified }))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not load diff."));
    return () => {
      cancelled = true;
    };
  }, [repoKey, mode, path]);

  if (error) {
    return (
      <p className="p-4 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
        {error}
      </p>
    );
  }
  if (!sides) return <div className="vb-shimmer m-3 h-4 w-40 rounded-[3px]" />;
  return <DiffView path={path} original={sides.original} modified={sides.modified} />;
}

function TabStrip({ retrievedFiles }: { retrievedFiles: Set<string> }) {
  const tabs = useViberon((s) => s.tabs);
  const activeTabPath = useViberon((s) => s.activeTabPath);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const descriptions = useMemo(() => tabDescriptions(tabs), [tabs]);

  useEffect(() => {
    const el = stripRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabPath]);

  return (
    <div
      ref={stripRef}
      role="tablist"
      className="flex h-[34px] shrink-0 items-stretch overflow-x-auto border-b"
      style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}
    >
      {tabs.map((tab, index) => {
        const active = tab.path === activeTabPath;
        const closable = tab.path !== WELCOME_TAB_PATH || tabs.length > 1;
        const description = descriptions.get(tab.path);
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            data-active={active}
            draggable
            onDragStart={() => {
              dragFrom.current = index;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragFrom.current !== null) useViberon.getState().moveTab(dragFrom.current, index);
              dragFrom.current = null;
            }}
            onMouseDown={(e) => {
              // Middle click closes, as everywhere else.
              if (e.button === 1 && closable) {
                e.preventDefault();
                useViberon.getState().closeTab(tab.path);
              }
            }}
            onDoubleClick={() => useViberon.getState().pinTab(tab.path)}
            onClick={() => useViberon.getState().activateTab(tab.path)}
            className={cx(
              "group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r pl-3 pr-1.5 text-[12.5px]",
              !active && "hover:bg-[var(--vb-hover)]",
            )}
            style={{
              borderColor: "var(--vb-line)",
              background: active ? "var(--vb-bg-base)" : "transparent",
              color: active ? "var(--vb-text-hi)" : "var(--vb-text-dim)",
            }}
            title={isSyntheticTab(tab.path) ? tab.label : tab.path}
          >
            {active && <span className="absolute inset-x-0 top-0 h-px" style={{ background: "var(--vb-accent)" }} />}
            {active && <span className="absolute inset-x-0 -bottom-px h-px" style={{ background: "var(--vb-bg-base)" }} />}
            <span className={cx("truncate", tab.preview && "italic")}>{tab.label}</span>
            {description && (
              <span className="truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
                {description}
              </span>
            )}
            {!tab.dirty && retrievedFiles.has(tab.path) && <Dot color="var(--vb-add)" size={5} />}
            {closable && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  useViberon.getState().closeTab(tab.path);
                }}
                title="Close (⌘W)"
                aria-label={`Close ${tab.label}`}
                className={cx(
                  "group/close inline-flex size-[18px] shrink-0 items-center justify-center rounded-[3px] hover:bg-[var(--vb-active)]",
                  !tab.dirty && !active && "opacity-0 group-hover:opacity-100",
                )}
              >
                {tab.dirty ? (
                  <>
                    <span className="size-2 rounded-full group-hover/close:hidden" style={{ background: "var(--vb-text-mid)" }} />
                    <X className="hidden size-3.5 group-hover/close:block" />
                  </>
                ) : (
                  <X className="size-3.5" />
                )}
              </button>
            )}
          </div>
        );
      })}
      <div className="flex-1" />
    </div>
  );
}

export default EditorPane;
