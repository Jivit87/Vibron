/**
 * Monaco themes mirroring the CSS tokens in app/globals.css. Monaco needs
 * literal hex values, so these are the one place tokens are duplicated.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoLike = any;

let defined = false;

export function defineViberonThemes(monaco: MonacoLike): void {
  if (defined) return;
  defined = true;
  // The browser-side TS worker has no project context (no node_modules, no
  // tsconfig), so its semantic errors are mostly false ("Cannot find
  // module"). Keep syntax errors; real type errors come from Problems.
  for (const defaults of [
    monaco.languages?.typescript?.typescriptDefaults,
    monaco.languages?.typescript?.javascriptDefaults,
  ]) {
    defaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  monaco.editor.defineTheme("viberon-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#151516",
      "editorGutter.background": "#151516",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editorLineNumber.foreground": "#4a4a4e",
      "editorLineNumber.activeForeground": "#a8a8ab",
      "editorIndentGuide.background1": "#ffffff0d",
      "editor.selectionBackground": "#6b9eff38",
      "editorCursor.foreground": "#d6d6d6",
      "editorWidget.background": "#1d1d1f",
      "editorWidget.border": "#34343a",
      "diffEditor.insertedTextBackground": "#6cbf8424",
      "diffEditor.removedTextBackground": "#e0736f24",
      "diffEditor.insertedLineBackground": "#6cbf8414",
      "diffEditor.removedLineBackground": "#e0736f14",
      "scrollbarSlider.background": "#ffffff14",
    },
  });
  monaco.editor.defineTheme("viberon-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editor.lineHighlightBackground": "#0000000a",
      "editor.lineHighlightBorder": "#00000000",
      "editorLineNumber.foreground": "#b0b0b6",
      "editorLineNumber.activeForeground": "#505056",
      "editor.selectionBackground": "#2f6bd82e",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#cfcfd4",
      "diffEditor.insertedTextBackground": "#2d8a4e22",
      "diffEditor.removedTextBackground": "#c4413c22",
      "diffEditor.insertedLineBackground": "#2d8a4e10",
      "diffEditor.removedLineBackground": "#c4413c10",
    },
  });
}

export function monacoThemeName(theme: "dark" | "light"): string {
  return theme === "light" ? "viberon-light" : "viberon-dark";
}

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx") || lower.endsWith(".js") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "css";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".sql")) return "sql";
  return "plaintext";
}
