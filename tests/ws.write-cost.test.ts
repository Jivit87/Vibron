import { mkdtemp, mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { parseStats } from "@/lib/parser";
import { getFileInfo, getGraph, putRawFiles, resetMemoryStoreForTests } from "@/lib/store";
import { deleteFile, fullReindex, openWorkspace, writeFile, type WorkspaceHandle } from "@/lib/workspace";
import { clearGraphIndexCache } from "@/lib/workspace/graph-index";

const FILES = 40;

describe("incremental writes", () => {
  beforeEach(() => {
    resetMemoryStoreForTests();
    clearGraphIndexCache();
  });

  it("a disk write re-parses exactly one file and keeps cross-file edges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-writecost-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < FILES; i += 1) {
      await fsWriteFile(
        path.join(root, "src", `m${i}.ts`),
        `import { util } from "./util";\nexport function f${i}() { return util(${i}); }\n`,
      );
    }
    await fsWriteFile(path.join(root, "src", "util.ts"), "export function util(n: number) { return n; }\n");
    const meta = await registerLocalWorkspace(root);
    const handle = await openWorkspace(meta.repoKey);

    const before = parseStats.filesParsed;
    await writeFile(
      handle,
      "src/util.ts",
      "export function util(n: number) { return helper(n); }\nexport function helper(n: number) { return n * 2; }\n",
    );
    expect(parseStats.filesParsed - before).toBe(1);

    const graph = (await getGraph(meta.repoKey))!;
    const util = graph.nodes.find((n) => n.name === "util")!;
    const helper = graph.nodes.find((n) => n.name === "helper")!;
    const f7 = graph.nodes.find((n) => n.name === "f7")!;
    // Edges from other (unparsed) files into the rewritten file survive re-linking.
    expect(graph.edges.some((e) => e.source === f7.id && e.target === util.id && e.kind === "call")).toBe(true);
    expect(graph.edges.some((e) => e.source === util.id && e.target === helper.id)).toBe(true);
    const info = await getFileInfo(meta.repoKey);
    expect(info.length).toBe(FILES + 1);

    // Delete is incremental too.
    const beforeDelete = parseStats.filesParsed;
    await deleteFile(handle, "src/m0.ts");
    expect(parseStats.filesParsed - beforeDelete).toBe(0);
    expect((await getGraph(meta.repoKey))!.nodes.some((n) => n.name === "f0")).toBe(false);
  });

  it("a store-workspace write re-parses one file", async () => {
    const handle: WorkspaceHandle = { repoKey: "wc-store", rootPath: null, repoRef: "t/r@main", label: "t" };
    await putRawFiles(
      handle.repoKey,
      Array.from({ length: FILES }, (_, i) => ({ path: `m${i}.py`, source: `def f${i}():\n    return ${i}\n` })),
    );
    await fullReindex(handle);
    const before = parseStats.filesParsed;
    await writeFile(handle, "new.py", "def fresh():\n    return f1()\n");
    expect(parseStats.filesParsed - before).toBe(1);
    expect((await getGraph(handle.repoKey))!.nodes.some((n) => n.name === "fresh")).toBe(true);
  });
});
