import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { changedFiles, diff, restore, restoreFile, snapshot, withOriginal } from "@/lib/harness/snapshot";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

let repo: TmpRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe("snapshots (git checkout)", () => {
  it("diffs against a base snapshot without touching the user's index or HEAD", async () => {
    repo = makeTmpRepo({ "a.py": "x = 1\n", "b.py": "y = 2\n", ".gitignore": "build/\n" });
    repo.write("notes.txt", "user's own untracked work\n");
    const base = await snapshot(repo.root);
    const head = repo.git("rev-parse", "HEAD");

    repo.write("a.py", "x = 42\n");
    repo.write("c.py", "z = 3\n");
    repo.write(".viberon/scratch/repro.py", "assert False\n");
    repo.write("pkg/__pycache__/a.cpython-311.pyc", "junk");
    repo.write("build/out.txt", "ignored");

    expect(await changedFiles(repo.root, base)).toEqual([
      { status: "M", path: "a.py" },
      { status: "A", path: "c.py" },
    ]);
    const patch = await diff(repo.root, base);
    expect(patch).toMatch(/-x = 1\n\+x = 42/);
    expect(patch).not.toMatch(/notes\.txt|viberon|pycache|build/);
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("status", "--porcelain")).not.toMatch(/^[MA] /m);
  });

  it("restores a snapshot and single files", async () => {
    repo = makeTmpRepo({ "a.py": "x = 1\n" });
    const base = await snapshot(repo.root);
    repo.write("a.py", "x = 2\n");
    repo.write("new.py", "n = 1\n");
    const mid = await snapshot(repo.root);
    repo.write("a.py", "x = 3\n");

    await restore(repo.root, mid);
    expect(repo.read("a.py")).toBe("x = 2\n");
    await restoreFile(repo.root, base, "new.py");
    expect(existsSync(path.join(repo.root, "new.py"))).toBe(false);
    await restore(repo.root, base);
    expect(repo.read("a.py")).toBe("x = 1\n");
    expect(await changedFiles(repo.root, base)).toEqual([]);
  });

  it("withOriginal runs in a checkout of the base while the work tree keeps the patch", async () => {
    repo = makeTmpRepo({ "lib.js": "module.exports = 1;\n", ".gitignore": "node_modules/\n" });
    repo.write("node_modules/dep/index.js", "module.exports = 'dep';\n");
    const base = await snapshot(repo.root);
    repo.write("lib.js", "module.exports = 2;\n");
    repo.write(".viberon/scratch/repro.js", "console.log(require('../../lib'))\n");

    const seen = await withOriginal(repo.root, base, async (dir) => ({
      dir,
      lib: readFileSync(path.join(dir, "lib.js"), "utf8"),
      dep: readFileSync(path.join(dir, "node_modules/dep/index.js"), "utf8"),
      repro: existsSync(path.join(dir, ".viberon/scratch/repro.js")),
    }));
    expect(seen).toMatchObject({ lib: "module.exports = 1;\n", dep: "module.exports = 'dep';\n", repro: true });
    expect(existsSync(seen.dir)).toBe(false);
    expect(repo.read("lib.js")).toBe("module.exports = 2;\n");
  });
});

describe("snapshots (plain directory)", () => {
  it("uses a shadow git dir under .viberon/", async () => {
    repo = makeTmpRepo({ "a.py": "x = 1\n" }, { git: false });
    const base = await snapshot(repo.root);
    repo.write("a.py", "x = 2\n");
    repo.write("node_modules/x/i.js", "junk");
    expect(await changedFiles(repo.root, base)).toEqual([{ status: "M", path: "a.py" }]);
    expect(existsSync(path.join(repo.root, ".git"))).toBe(false);
    const original = await withOriginal(repo.root, base, async (dir) => ({
      a: readFileSync(path.join(dir, "a.py"), "utf8"),
      dep: existsSync(path.join(dir, "node_modules/x/i.js")),
    }));
    expect(original).toEqual({ a: "x = 1\n", dep: true });
  });
});
