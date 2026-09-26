import { repoKey as makeRepoKey } from "@/lib/ids";
import { parseRepo } from "@/lib/parser";
import { countTokens } from "@/lib/tokens";
import type { RepoFile } from "@/lib/github";
import {
  getFileInfo,
  getGraph,
  getRawFiles,
  putFileInfo,
  putGraph,
  putRawFiles,
} from "@/lib/store";

export const PRODUCT_NAME = "Viberon";

const LOCAL_WORKSPACE_REPO_REF = "viberon/local-workspace@main";
const LOCAL_WORKSPACE_KEY = makeRepoKey(LOCAL_WORKSPACE_REPO_REF);

const SEED_FILES: RepoFile[] = [
  {
    path: "src/app.tsx",
    source: `import { buildWelcomeMessage } from "./lib/welcome";

export function App() {
  const lines = buildWelcomeMessage("Viberon");

  return (
    <main>
      <h1>{lines.title}</h1>
      <p>{lines.body}</p>
    </main>
  );
}
`,
  },
  {
    path: "src/lib/welcome.ts",
    source: `export interface WelcomeCopy {
  title: string;
  body: string;
}

export function buildWelcomeMessage(productName: string): WelcomeCopy {
  return {
    title: productName + " Workspace",
    body: "Start editing files, ask for changes, and shape the app from one place.",
  };
}
`,
  },
  {
    path: "src/lib/session.ts",
    source: `export interface SessionState {
  mode: "ask" | "edit" | "agent";
  activeFile?: string;
}

export function nextMode(state: SessionState): SessionState["mode"] {
  if (state.mode === "ask") return "edit";
  if (state.mode === "edit") return "agent";
  return "ask";
}
`,
  },
  {
    path: "README.md",
    source: `# Viberon

This workspace is the local starter project for the desktop app.

- Open a file from the sidebar
- Ask the assistant to make changes
- Iterate inside the same software workspace
`,
  },
  {
    path: "package.json",
    source: `{
  "name": "viberon-workspace",
  "private": true,
  "version": "0.0.1"
}
`,
  },
];

/**
 * The desktop app opens straight into a workspace, so `/` seeds a small
 * local demo project (once) instead of showing an empty ingest form.
 */
export async function ensureLocalWorkspace(): Promise<string> {
  const [graph, files, rawFiles] = await Promise.all([
    getGraph(LOCAL_WORKSPACE_KEY),
    getFileInfo(LOCAL_WORKSPACE_KEY),
    getRawFiles(LOCAL_WORKSPACE_KEY),
  ]);

  if (graph && files.length > 0 && rawFiles.length > 0) {
    return LOCAL_WORKSPACE_KEY;
  }

  const parsed = parseRepo(SEED_FILES, LOCAL_WORKSPACE_REPO_REF);
  await Promise.all([
    putRawFiles(LOCAL_WORKSPACE_KEY, SEED_FILES),
    putGraph(LOCAL_WORKSPACE_KEY, parsed.graph),
    putFileInfo(
      LOCAL_WORKSPACE_KEY,
      SEED_FILES.map((file) => ({ path: file.path, tokenCount: countTokens(file.source) })),
    ),
  ]);

  return LOCAL_WORKSPACE_KEY;
}
