import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isIgnoredPath, watchWorkspace, type FsEvent } from "@/lib/workspace/watcher";

async function collect(root: string, act: () => Promise<void>, ms = 800): Promise<FsEvent> {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const stop = watchWorkspace(root, (e) => {
    e.changed.forEach((p) => changed.add(p));
    e.deleted.forEach((p) => deleted.add(p));
  });
  await new Promise((r) => setTimeout(r, 100));
  await act();
  await new Promise((r) => setTimeout(r, ms));
  stop();
  return { type: "fs", changed: [...changed].sort(), deleted: [...deleted].sort() };
}

describe.runIf(process.platform === "darwin" || process.platform === "win32" || process.platform === "linux")(
  "watchWorkspace",
  () => {
    it("reports changes and deletions, skipping ignored dirs", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "vb-watch-"));
      await writeFile(path.join(root, "gone.txt"), "x");
      await mkdir(path.join(root, "node_modules"), { recursive: true });
      await mkdir(path.join(root, "src"), { recursive: true });
      await new Promise((r) => setTimeout(r, 150));
      const event = await collect(root, async () => {
        await writeFile(path.join(root, "src", "a.ts"), "a");
        await writeFile(path.join(root, "node_modules", "x.js"), "x");
        await rm(path.join(root, "gone.txt"));
      });
      expect(event.changed).toContain("src/a.ts");
      expect(event.deleted).toContain("gone.txt");
      expect([...event.changed, ...event.deleted].some((p) => p.startsWith("node_modules"))).toBe(false);
    });
  },
);

describe("isIgnoredPath", () => {
  it("matches any ignored segment", () => {
    expect(isIgnoredPath("node_modules/a.js")).toBe(true);
    expect(isIgnoredPath("pkg/.git/HEAD")).toBe(true);
    expect(isIgnoredPath("src/git.ts")).toBe(false);
  });
});
