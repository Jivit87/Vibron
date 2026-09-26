import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/git/route";
import { POST as registerWorkspace } from "@/app/api/workspaces/route";
import { resolveGitPaths } from "@/lib/git";
import { isValidBranchName, parseStatusV2 } from "@/lib/git/parse";
import { resetMemoryStoreForTests } from "@/lib/store";

const BIN = "git";

function sh(cwd: string, ...args: string[]) {
  return execFileSync(BIN, args, { cwd, encoding: "utf8" });
}

async function setup(initRepo = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vb-scm-"));
  if (initRepo) {
    sh(root, "init", "-q", "-b", "main");
    sh(root, "config", "user.email", "t@example.com");
    sh(root, "config", "user.name", "Test");
    sh(root, "config", "commit.gpgsign", "false");
  }
  const res = await registerWorkspace(
    new Request("http://localhost/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ rootPath: root }),
    }),
  );
  const { repoKey } = (await res.json()) as { repoKey: string };
  return { root, repoKey };
}

/** The response fields these tests read from /api/git. */
interface ScmFile {
  path: string;
  group: string;
  letter: string;
}
interface ScmBody {
  status: { files: ScmFile[]; branch: { head: string } };
  log: { subject: string; author: string; date: number }[];
  branches: unknown[];
  content: string | null;
  [key: string]: unknown;
}

async function get(query: Record<string, string>) {
  const res = await GET(new Request(`http://localhost/api/git?${new URLSearchParams(query)}`));
  return { status: res.status, body: (await res.json()) as ScmBody };
}

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as ScmBody };
}

beforeEach(() => resetMemoryStoreForTests());

describe("git API against a real repo", () => {
  it("snapshot → stage → commit → log", async () => {
    const { root, repoKey } = await setup();
    await writeFile(path.join(root, "a.txt"), "one\n");
    await mkdir(path.join(root, "dir with space"));
    await writeFile(path.join(root, "dir with space", "ü.txt"), "x\n");

    let snap = (await get({ repoKey })).body;
    expect(snap).toMatchObject({ virtual: false, isRepo: true, gitAvailable: true, parentRepo: null });
    expect(snap.status.branch).toMatchObject({ head: "main", oid: null, ahead: 0, behind: 0 });
    expect(snap.status.files.map((f) => [f.path, f.group, f.letter]).sort()).toEqual([
      ["a.txt", "untracked", "?"],
      ["dir with space/ü.txt", "untracked", "?"],
    ]);
    expect(snap.log).toEqual([]);

    snap = (await post({ repoKey, op: "stage", paths: ["a.txt"] })).body;
    expect(snap.status.files.find((f) => f.path === "a.txt")).toMatchObject({ group: "staged", letter: "A" });

    const committed = await post({ repoKey, op: "commit", message: "first" });
    expect(committed.status).toBe(200);
    expect(committed.body.log[0]).toMatchObject({ subject: "first", author: "Test" });
    expect(typeof committed.body.log[0].date).toBe("number");
    expect(committed.body.branches).toEqual([{ name: "main", current: true, upstream: null }]);

    // Modify after commit, then stage all.
    await writeFile(path.join(root, "a.txt"), "two\n");
    snap = (await post({ repoKey, op: "stage", paths: "all" })).body;
    expect(snap.status.files.every((f) => f.group === "staged")).toBe(true);

    // show at HEAD / INDEX / WORKING, and a file absent at HEAD.
    expect((await get({ repoKey, op: "show", path: "a.txt", ref: "HEAD" })).body).toEqual({ path: "a.txt", ref: "HEAD", content: "one\n" });
    expect((await get({ repoKey, op: "show", path: "a.txt", ref: "INDEX" })).body.content).toBe("two\n");
    expect((await get({ repoKey, op: "show", path: "a.txt", ref: "WORKING" })).body.content).toBe("two\n");
    expect((await get({ repoKey, op: "show", path: "dir with space/ü.txt", ref: "HEAD" })).body.content).toBeNull();
    expect((await get({ repoKey, op: "show", path: "nope.txt", ref: "WORKING" })).body.content).toBeNull();
  });

  it("unstage and discard", async () => {
    const { root, repoKey } = await setup();
    await writeFile(path.join(root, "a.txt"), "one\n");
    await post({ repoKey, op: "stage", paths: "all" });
    await post({ repoKey, op: "commit", message: "init" });

    await writeFile(path.join(root, "a.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    await post({ repoKey, op: "stage", paths: ["a.txt"] });
    let snap = (await post({ repoKey, op: "unstage", paths: ["a.txt"] })).body;
    expect(snap.status.files.find((f) => f.path === "a.txt")?.group).toBe("changes");

    snap = (await post({ repoKey, op: "discard", paths: "all" })).body;
    expect(snap.status.files).toEqual([]);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("branches: create, switch, reject bad names", async () => {
    const { root, repoKey } = await setup();
    await writeFile(path.join(root, "a.txt"), "one\n");
    await post({ repoKey, op: "stage", paths: "all" });
    await post({ repoKey, op: "commit", message: "init" });

    let res = await post({ repoKey, op: "createBranch", name: "feature/x" });
    expect(res.body.status.branch.head).toBe("feature/x");
    res = await post({ repoKey, op: "switch", name: "main" });
    expect(res.body.status.branch.head).toBe("main");
    expect((await post({ repoKey, op: "switch", name: "--orphan" })).status).toBe(400);
    expect((await post({ repoKey, op: "createBranch", name: "a..b" })).status).toBe(400);
  });

  it("rejects paths that escape or smuggle options", async () => {
    const { repoKey } = await setup();
    for (const bad of [["../x"], ["/etc/passwd"], ["-A"], [":(glob)**"], [".git/config"], []]) {
      expect((await post({ repoKey, op: "stage", paths: bad })).status).toBe(400);
    }
    expect((await get({ repoKey, op: "show", path: "../x", ref: "HEAD" })).status).toBe(400);
    expect((await get({ repoKey, op: "show", path: "a", ref: "HEAD~1" })).status).toBe(400);
  });

  it("commit with nothing staged is a 409, empty message a 400", async () => {
    const { repoKey } = await setup();
    expect((await post({ repoKey, op: "commit", message: "x" })).status).toBe(409);
    expect((await post({ repoKey, op: "commit", message: "  " })).status).toBe(400);
  });

  it("init turns a plain folder into a repo; nested folder is not a repo", async () => {
    const { root, repoKey } = await setup(false);
    const before = (await get({ repoKey })).body;
    expect(before.isRepo).toBe(false);
    const after = (await post({ repoKey, op: "init" })).body;
    expect(after.isRepo).toBe(true);

    const nested = path.join(root, "sub");
    await mkdir(nested);
    const res = await registerWorkspace(
      new Request("http://localhost/api/workspaces", { method: "POST", body: JSON.stringify({ rootPath: nested }) }),
    );
    const { repoKey: nestedKey } = (await res.json()) as { repoKey: string };
    const snap = (await get({ repoKey: nestedKey })).body;
    expect(snap.isRepo).toBe(false);
    expect(typeof snap.parentRepo).toBe("string");
    expect((await post({ repoKey: nestedKey, op: "commit", message: "x" })).status).toBe(400);
  });

  it("virtual workspace returns the virtual snapshot", async () => {
    const { body } = await get({ repoKey: "does-not-exist" });
    expect(body).toEqual({ virtual: true, isRepo: false, gitAvailable: false, parentRepo: null });
  });
});

describe("git parse helpers", () => {
  it("parses renames and conflicts", () => {
    const out = [
      "# branch.oid abcdef0123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
      "",
    ].join("\0");
    const status = parseStatusV2(out);
    expect(status.branch).toEqual({ head: "main", oid: "abcdef0", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(status.files).toEqual([
      { path: "new name.txt", originalPath: "old name.txt", group: "staged", letter: "R" },
      { path: "conflict.txt", group: "conflicts", letter: "U" },
    ]);
  });

  it("validates branch names and paths", () => {
    expect(isValidBranchName("feat/ok-1")).toBe(true);
    for (const bad of ["-x", "a b", "a..b", "x.lock", "@", "a~1", "a:b", ".hidden", "a/"]) {
      expect(isValidBranchName(bad)).toBe(false);
    }
    expect(() => resolveGitPaths("/r", ["a/../../b"])).toThrow();
    expect(resolveGitPaths("/r", ["a/./b"])).toEqual(["a/b"]);
  });
});
