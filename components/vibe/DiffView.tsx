"use client";

/**
 * Monaco DiffEditor wrapped with the app theme. Used by the agent-edit
 * review and by Source Control diff tabs.
 *
 * Review findings for this file (from Source Control's Review or a PR
 * review) are listed above the diff and marked on the modified side where
 * their line exists: a tinted line, a severity glyph, and the finding as
 * the hover.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { DiffOnMount } from "@monaco-editor/react";

import { defineViberonThemes, languageFor, monacoThemeName } from "@/lib/client/monaco-theme";
import { findingsForPath, type Finding } from "@/lib/client/review";
import { useReview } from "@/store/review";
import { resolveTheme, useViberon } from "@/store/viberon";
import { SEVERITY } from "@/components/vibe/CodeReview";

const MonacoDiff = dynamic(() => import("@monaco-editor/react").then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => <div className="vb-shimmer m-3 h-4 w-40 rounded-[3px]" />,
});

type DiffEditorInstance = Parameters<DiffOnMount>[0];
type Decorations = ReturnType<ReturnType<DiffEditorInstance["getModifiedEditor"]>["createDecorationsCollection"]>;

export function DiffView({
  path,
  original,
  modified,
  inline = false,
}: {
  path: string;
  original: string;
  modified: string;
  inline?: boolean;
}) {
  const theme = useViberon((s) => s.settings.theme);
  const fontSize = useViberon((s) => s.settings.editorFontSize);
  const name = monacoThemeName(resolveTheme(theme));

  const local = useReview((s) => s.review?.findings);
  const pr = useReview((s) => s.pr?.review?.findings);
  const findings = useMemo(
    () => findingsForPath([...(local ?? []), ...(pr ?? [])], path),
    [local, pr, path],
  );

  const editorRef = useRef<DiffEditorInstance | null>(null);
  const decorationsRef = useRef<Decorations | null>(null);
  const [mounted, setMounted] = useState(0);

  useEffect(() => {
    const editor = editorRef.current?.getModifiedEditor();
    if (!editor) return;
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    const decorations = findings
      .filter((f): f is Finding & { line: number } => typeof f.line === "number" && f.line <= lineCount)
      .map((f) => ({
        range: { startLineNumber: f.line, startColumn: 1, endLineNumber: f.line, endColumn: 1 },
        options: {
          isWholeLine: true,
          className: `viberon-finding-line-${f.severity}`,
          glyphMarginClassName: `viberon-finding-glyph viberon-finding-glyph-${f.severity}`,
          hoverMessage: { value: `**${f.severity}** · ${escapeMd(f.title)}${f.detail ? `\n\n${escapeMd(f.detail)}` : ""}` },
        },
      }));
    decorationsRef.current?.clear();
    decorationsRef.current = decorations.length ? editor.createDecorationsCollection(decorations) : null;
  }, [findings, mounted, modified]);

  function reveal(line: number) {
    const editor = editorRef.current?.getModifiedEditor();
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {findings.length > 0 && <FindingStrip findings={findings} onReveal={reveal} />}
      <div className="min-h-0 flex-1">
        <MonacoDiff
          height="100%"
          theme={name}
          language={languageFor(path)}
          original={original}
          modified={modified}
          beforeMount={(monaco) => defineViberonThemes(monaco)}
          onMount={(editor) => {
            editorRef.current = editor;
            setMounted((n) => n + 1);
          }}
          // Without these, unmounting throws "TextModel got disposed before
          // DiffEditorWidget model got reset" (a known @monaco-editor/react issue).
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: true,
            renderSideBySide: !inline,
            fontSize,
            fontLigatures: false,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderOverviewRuler: false,
            automaticLayout: true,
            lineNumbersMinChars: 3,
            glyphMargin: findings.length > 0,
            hideUnchangedRegions: { enabled: true },
          }}
        />
      </div>
    </div>
  );
}

function escapeMd(text: string): string {
  return text.replace(/([\\*_[\]<>])/g, "\\$1");
}

/** The file's findings as rows above the diff; a row jumps to its line. */
function FindingStrip({ findings, onReveal }: { findings: Finding[]; onReveal: (line: number) => void }) {
  return (
    <div className="max-h-[96px] shrink-0 overflow-y-auto border-b py-0.5" style={{ borderColor: "var(--vb-line)" }} aria-label="Review findings">
      {findings.map((f, i) => {
        const sev = SEVERITY[f.severity];
        return (
          <button
            key={`${f.line}:${i}`}
            type="button"
            disabled={!f.line}
            onClick={() => f.line && onReveal(f.line)}
            className="flex h-[22px] w-full min-w-0 items-center gap-2 px-3 text-left text-[12px] hover:bg-[var(--vb-hover)] disabled:hover:bg-transparent"
            title={f.detail}
          >
            <span className="w-[26px] shrink-0 font-mono text-[10.5px]" style={{ color: sev.color }}>
              {sev.label}
            </span>
            <span className="w-[34px] shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {f.line ? `L${f.line}` : "—"}
            </span>
            <span className="shrink-0" style={{ color: "var(--vb-text)" }}>
              {f.title}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {f.detail}
            </span>
          </button>
        );
      })}
    </div>
  );
}
