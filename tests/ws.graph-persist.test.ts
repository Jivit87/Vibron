import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  lastIndexStats,
  refreshLocalWorkspace,
  registerLocalWorkspace,
  scanLocalWorkspace,
} from "@/lib/local-disk-workspace";
import { getGraph, resetMemoryStoreForTests } from "@/lib/store";
import { clearGraphIndexCache } from "@/lib/workspace/graph-index";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-persist-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await mkdir(path.join(root, "pkg"), { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    await writeFile(path.join(root, "pkg", `m${i}.py`), `def f${i}():\n    return ${i}\n`);
  }
  await writeFile(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
  // Ignored noise: venvs, caches, build output.
  await mkdir(path.join(root, ".venv", "lib"), { recursive: true });
  await writeFile(path.join(root, ".venv", "lib", "x.py"), "def venv(): pass\n");
  await mkdir(path.join(root, "myenv"), { recursive: true });
  await writeFile(path.join(root, "myenv", "pyvenv.cfg"), "home = /usr\n");
  await writeFile(path.join(root, "myenv", "y.py"), "def env(): pass\n");
  await mkdir(path.join(root, "__pycache__"), { recursive: true });
  await writeFile(path.join(root, "__pycache__", "z.py"), "def cache(): pass\n");
  await mkdir(path.join(root, "target"), { recursive: true });
  await writeFile(path.join(root, "target", "out.rs"), "fn built() {}\n");
  return root;
}

describe("persistent graph index", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    clearGraphIndexCache();
  });

  it("skips ignored dirs and virtualenvs when scanning", async () => {
    const root = await makeRepo();
    const paths = (await scanLocalWorkspace(root)).map((f) => f.path);
    expect(paths).toContain("pkg/m0.py");
    expect(paths).toContain("main.go");
    expect(paths.some((p) => /venv|myenv|__pycache__|target/.test(p))).toBe(false);
  });

  it("persists to .viberon/graph.json, excludes it from git, and reparses only changed files", async () => {
    const root = await makeRepo();
    const meta = await registerLocalWorkspace(root);
    expect(existsSync(path.join(root, ".viberon", "graph.json"))).toBe(true);
    const exclude = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.viberon/");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).not.toContain(
      ".viberon",
    );
    expect(lastIndexStats.get(meta.repoKey)).toMatchObject({ parsed: 6, reused: 0 });

    // Simulate an app restart: in-process cache gone, disk cache remains.
    clearGraphIndexCache();
    await writeFile(path.join(root, "pkg", "m3.py"), "def f3():\n    return 33\n\ndef g3():\n    return f3()\n");
    await refreshLocalWorkspace(meta.repoKey);
    expect(lastIndexStats.get(meta.repoKey)).toMatchObject({ parsed: 1, reused: 5 });

    const graph = await getGraph(meta.repoKey);
    expect(graph?.nodes.map((n) => n.name)).toContain("g3");
    expect(graph?.nodes.map((n) => n.name)).toContain("main");

    // Registering again is idempotent for the exclude file.
    await registerLocalWorkspace(root);
    const again = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(again.match(/\/\.viberon\//g)).toHaveLength(1);
  });
});
