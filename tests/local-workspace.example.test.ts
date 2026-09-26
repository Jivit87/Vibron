import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as registerWorkspace } from "@/app/api/workspaces/route";
import {
  GET as getRepoFile,
  PUT as putRepoFile,
} from "@/app/api/repos/files/[repoKey]/route";
import { ContextLedger } from "@/lib/context/ledger";
import { runTool, type ToolContext } from "@/lib/tools/registry";
import { openWorkspace, fullReindex } from "@/lib/workspace";
import { getFileInfo } from "@/lib/store";
import { readFile as wsReadFile } from "@/lib/workspace";
import {
  getGraph,
  getLocalWorkspace,
  getRawFile,
  resetMemoryStoreForTests,
} from "@/lib/store";

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "viberon-workspace-"));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function register(rootPath: string): Promise<{ repoKey: string; label: string }> {
  const response = await registerWorkspace(
    new Request("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ repoKey: string; label: string }>;
}


/** Build a tool context bound to a real on-disk workspace. */
async function toolContextFor(
  repoKey: string,
  writeScope?: string[],
): Promise<ToolContext> {
  const handle = await openWorkspace(repoKey);
  const { graph, memory } = await fullReindex(handle);
  const ledger = new ContextLedger();
  return {
    handle,
    memory,
    agent: "Test",
    commandPolicy: "never",
    writeScope,
    events: {},
    engine: {
      graph,
      memory,
      fileInfo: await getFileInfo(repoKey),
      readFile: (filePath) => wsReadFile(handle, filePath),
      ledger,
    },
  };
}

describe("disk-backed local workspaces", () => {
  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    resetMemoryStoreForTests();
  });

  it("registers a selected folder, indexes text files, and ignores generated folders", async () => {
    const rootPath = await createTempWorkspace();
    await mkdir(path.join(rootPath, "src"), { recursive: true });
    await mkdir(path.join(rootPath, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      path.join(rootPath, "src", "app.ts"),
      "export function createApp() {\n  return 'ready';\n}\n",
    );
    await writeFile(path.join(rootPath, "README.md"), "# Local app\n");
    await writeFile(
      path.join(rootPath, "node_modules", "pkg", "ignored.ts"),
      "export function ignored() {}\n",
    );

    const { repoKey, label } = await register(rootPath);

    expect(label).toBe(path.basename(rootPath));
    await expect(getLocalWorkspace(repoKey)).resolves.toMatchObject({ rootPath });
    await expect(getGraph(repoKey)).resolves.toMatchObject({
      meta: { fileCount: 1 },
      nodes: [expect.objectContaining({ name: "createApp", file: "src/app.ts" })],
    });
    await expect(getRawFile(repoKey, "README.md")).resolves.toMatchObject({
      source: "# Local app\n",
    });

    const manifest = await getRepoFile(
      new Request(`http://localhost/api/repos/files/${repoKey}`),
      { params: Promise.resolve({ repoKey }) },
    );
    const body = (await manifest.json()) as { files: { path: string }[] };
    expect(body.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "src/app.ts",
    ]);
  });

  it("writes editor saves to the selected folder on disk and refreshes graph memory", async () => {
    const rootPath = await createTempWorkspace();
    const { repoKey } = await register(rootPath);
    const source = "export function tick() {\n  return 'snake';\n}\n";

    const response = await putRepoFile(
      new Request(`http://localhost/api/repos/files/${repoKey}?path=src/game.js`, {
        method: "PUT",
        body: JSON.stringify({ source }),
      }),
      { params: Promise.resolve({ repoKey }) },
    );

    expect(response.status).toBe(200);
    await expect(readFile(path.join(rootPath, "src", "game.js"), "utf8")).resolves.toBe(
      source,
    );
    await expect(getGraph(repoKey)).resolves.toMatchObject({
      nodes: [expect.objectContaining({ name: "tick", file: "src/game.js" })],
    });
  });

  it("rejects file paths that escape the selected folder", async () => {
    const rootPath = await createTempWorkspace();
    const { repoKey } = await register(rootPath);
    const outsidePath = path.join(rootPath, "..", "escape.js");

    const response = await putRepoFile(
      new Request(`http://localhost/api/repos/files/${repoKey}?path=../escape.js`, {
        method: "PUT",
        body: JSON.stringify({ source: "export const escaped = true;\n" }),
      }),
      { params: Promise.resolve({ repoKey }) },
    );

    expect(response.status).toBe(400);
    await expect(exists(outsidePath)).resolves.toBe(false);
  });

  it("agent write_file creates real files in the selected folder", async () => {
    const rootPath = await createTempWorkspace();
    const { repoKey } = await register(rootPath);
    const ctx = await toolContextFor(repoKey);

    const result = await runTool(
      "write_file",
      {
        path: "index.html",
        content: "<!doctype html>\n<title>Snake</title>\n",
        summary: "Create the snake game HTML shell.",
      },
      ctx,
    );

    expect(result).toContain("index.html");
    await expect(readFile(path.join(rootPath, "index.html"), "utf8")).resolves.toContain(
      "<title>Snake</title>",
    );
  });

  it("agent edit_file refuses a path outside its assigned scope", async () => {
    const rootPath = await createTempWorkspace();
    await writeFile(path.join(rootPath, "owned.ts"), "export const a = 1;\n");
    await writeFile(path.join(rootPath, "theirs.ts"), "export const b = 2;\n");
    const { repoKey } = await register(rootPath);

    // This is the invariant that makes parallel agents safe: a specialist
    // may only write the files its plan step claimed.
    const ctx = await toolContextFor(repoKey, ["owned.ts"]);

    const allowed = await runTool(
      "edit_file",
      { path: "owned.ts", find: "1", replace: "42", summary: "bump" },
      ctx,
    );
    const refused = await runTool(
      "edit_file",
      { path: "theirs.ts", find: "2", replace: "99", summary: "should not happen" },
      ctx,
    );

    expect(allowed).toContain("Edited owned.ts");
    expect(refused).toContain("outside your assigned scope");
    await expect(readFile(path.join(rootPath, "theirs.ts"), "utf8")).resolves.toContain(
      "= 2",
    );
  });

  it("agent edit_file requires a unique anchor unless replace_all is set", async () => {
    const rootPath = await createTempWorkspace();
    await writeFile(path.join(rootPath, "dup.ts"), "const x = 1;\nconst x = 1;\n");
    const { repoKey } = await register(rootPath);
    const ctx = await toolContextFor(repoKey);

    const ambiguous = await runTool(
      "edit_file",
      { path: "dup.ts", find: "const x = 1;", replace: "const y = 2;", summary: "s" },
      ctx,
    );
    expect(ambiguous).toContain("matches 2 times");

    const forced = await runTool(
      "edit_file",
      {
        path: "dup.ts",
        find: "const x = 1;",
        replace: "const y = 2;",
        replace_all: true,
        summary: "s",
      },
      ctx,
    );
    expect(forced).toContain("2 occurrences replaced");
  });

  it("agent delete_file removes the file from disk", async () => {
    const rootPath = await createTempWorkspace();
    await writeFile(path.join(rootPath, "trash.ts"), "export const gone = true;\n");
    const { repoKey } = await register(rootPath);
    const ctx = await toolContextFor(repoKey);

    const result = await runTool(
      "delete_file",
      { path: "trash.ts", summary: "no longer needed" },
      ctx,
    );

    expect(result).toContain("Deleted trash.ts");
    await expect(exists(path.join(rootPath, "trash.ts"))).resolves.toBe(false);
  });

  it("agent writes cannot escape the workspace", async () => {
    const rootPath = await createTempWorkspace();
    const { repoKey } = await register(rootPath);
    const ctx = await toolContextFor(repoKey);

    const result = await runTool(
      "write_file",
      { path: "../escaped.ts", content: "nope", summary: "should fail" },
      ctx,
    );

    expect(result).toMatch(/escapes the workspace|failed/i);
    await expect(exists(path.join(rootPath, "..", "escaped.ts"))).resolves.toBe(false);
  });
});
