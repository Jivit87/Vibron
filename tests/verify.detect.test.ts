import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCommand } from "@/lib/terminal";
import {
  buildRepoEnv,
  detectVerifyCommands,
  execInRepo,
  pytestAvailable,
  relatedTestFiles,
  runVerification,
  which,
} from "@/lib/verify";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-verify-"));
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), source);
  }
  return root;
}

const PY_REPO = {
  "pyproject.toml": "[project]\nname='textkit'\n",
  "textkit/__init__.py": "from .slug import slugify\n",
  "textkit/slug.py": "def slugify(s, sep='-'):\n    return s.lower().replace(' ', sep)\n",
  "tests/test_slug.py":
    "import unittest\nfrom textkit import slugify\n\nclass T(unittest.TestCase):\n    def test_simple(self):\n        self.assertEqual(slugify('Hello World'), 'hello-world')\n\n    def test_accents(self):\n        self.assertEqual(slugify('Crème'), 'creme')\n",
  "tests/test_other.py": "import unittest\n\nclass O(unittest.TestCase):\n    def test_x(self):\n        pass\n",
};

const hasPython = which("python3") !== null || which("python") !== null;

describe("detectVerifyCommands", () => {
  it.runIf(hasPython)("python repo: pytest when importable, else unittest; plus a syntax fallback", async () => {
    const root = await repo(PY_REPO);
    const commands = await detectVerifyCommands(root);
    const first = commands[0]!;
    if (pytestAvailable(root)) {
      expect(first.framework).toBe("pytest");
      expect(first.command).toContain("-rA");
    } else {
      expect(first).toMatchObject({ framework: "unittest", kind: "test" });
      expect(first.command).toBe("python -m unittest discover -v -s tests");
    }
    expect(commands.at(-1)).toMatchObject({ kind: "compile", framework: "custom" });
  });

  it("package.json: runner from lockfile, framework from script/deps", async () => {
    const vitestRoot = await repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }),
      "pnpm-lock.yaml": "",
    });
    expect((await detectVerifyCommands(vitestRoot))[0]).toMatchObject({
      command: "pnpm test",
      framework: "vitest",
      targetTemplate: "npx vitest run {files}",
    });
    const nodeRoot = await repo({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "test/a.test.js": "",
    });
    expect((await detectVerifyCommands(nodeRoot))[0]).toMatchObject({ command: "node --test", framework: "node-test" });
    const makeRoot = await repo({ Makefile: "test:\n\techo ok\n" });
    const make = await detectVerifyCommands(makeRoot);
    if (which("make")) expect(make[0]).toMatchObject({ command: "make test", framework: "make" });
    expect(await detectVerifyCommands(await repo({ "README.md": "hi" }))).toEqual([]);
  });
});

describe("runVerification", () => {
  it.runIf(hasPython)("runs the repo's tests with per-test outcomes and a failure excerpt", async () => {
    const root = await repo(PY_REPO);
    const [cmd] = await detectVerifyCommands(root);
    const report = await runVerification(root, cmd!, { timeoutMs: 60_000 });
    expect(report.exitCode).not.toBe(0);
    expect(report.parsed).toBe(true);
    expect(report.counts.failed).toBe(1);
    expect(report.counts.passed).toBe(2);
    const failing = Object.entries(report.tests).filter(([, o]) => o === "fail").map(([id]) => id);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toContain("test_accents");
    expect(report.failureExcerpt).toContain("AssertionError");
    // No bytecode written into the repo.
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(root, "textkit", "__pycache__"))).toBe(false);

    const targeted = await runVerification(root, cmd!, { timeoutMs: 60_000, targets: ["tests/test_other.py"] });
    expect(targeted.exitCode).toBe(0);
    expect(targeted.counts.passed).toBe(1);
  });

  it.runIf(hasPython)("the python syntax-check fallback survives the shell and names the broken file", async () => {
    const root = await repo({ "ok.py": "x = 1\n", "pkg/broken.py": "def f(:\n    pass\n" });
    const check = (await detectVerifyCommands(root)).find((c) => c.kind === "compile");
    const report = await runVerification(root, check!, { timeoutMs: 30_000 });
    expect(report.exitCode).toBe(1);
    expect(report.outputTail).toMatch(/pkg\/broken\.py:1: SyntaxError/);

    const clean = await repo({ "ok.py": "x = 1\n" });
    const cleanCheck = (await detectVerifyCommands(clean)).find((c) => c.kind === "compile");
    expect((await runVerification(clean, cleanCheck!, { timeoutMs: 30_000 })).exitCode).toBe(0);
  });

  it("node --test repo passes and reports a timeout as an error", async () => {
    const root = await repo({
      "test/a.test.js": "const test = require('node:test');\ntest('ok', () => {});\n",
      "test/slow.test.js": "",
    });
    const report = await runVerification(
      root,
      { command: "node --test test/a.test.js", framework: "node-test", kind: "test", source: "t" },
      { timeoutMs: 60_000 },
    );
    expect(report.exitCode).toBe(0);
    expect(report.tests).toEqual({ ok: "pass" });
    const slow = await runVerification(
      root,
      { command: "sleep 5", framework: "custom", kind: "test", source: "t" },
      { timeoutMs: 300 },
    );
    expect(slow.timedOut).toBe(true);
    expect(slow.counts.errors).toBe(1);
    expect(slow.failureExcerpt).toContain("timed out");
  });
});

describe("repo environment", () => {
  it.runIf(hasPython)("activates the repo venv and bridges python to python3", async () => {
    const root = await repo({ "a.py": "" });
    const python3 = which("python3") ?? which("python")!;
    await mkdir(path.join(root, ".venv", "bin"), { recursive: true });
    await symlink(python3, path.join(root, ".venv", "bin", "python"));
    const env = buildRepoEnv(root);
    expect(env.PATH!.split(path.delimiter)[0]).toBe(path.join(root, ".venv", "bin"));
    expect(env.VIRTUAL_ENV).toBe(path.join(root, ".venv"));
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
    const probe = await execInRepo(root, "python -c 'import sys; print(sys.version_info[0])'", { timeoutMs: 20_000 });
    expect(probe.output.trim()).toBe("3");

    const plain = await repo({ "b.py": "" });
    const shim = await execInRepo(plain, "python -c 'print(42)'", { timeoutMs: 20_000 });
    expect(shim.output.trim()).toBe("42");
  });

  it("never exposes API keys to repo commands", async () => {
    process.env.OPENAI_API_KEY = "sk-secret-test";
    try {
      const root = await repo({});
      const result = await execInRepo(root, "echo key=$OPENAI_API_KEY", { timeoutMs: 10_000 });
      expect(result.output.trim()).toBe("key=");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("runCommand condense keeps the failure, not a blind cut", async () => {
    const root = await repo({});
    const script = `for i in $(seq 1 3000); do echo "line $i ok"; done; echo 'Traceback (most recent call last):'; echo '  File "x.py", line 1'; echo 'ValueError: boom'; for i in $(seq 1 3000); do echo "after $i"; done; exit 1`;
    const result = await runCommand({ repoKey: "t", command: script, cwd: root, timeoutMs: 30_000, condense: true, maxOutputChars: 2000, origin: "agent" });
    expect(result.output).toContain("ValueError: boom");
    expect(result.output.length).toBeLessThanOrEqual(2000);
  });
});

describe("relatedTestFiles", () => {
  it("finds tests by name, import mention and graph edges", async () => {
    const root = await repo({
      ...PY_REPO,
      "tests/test_wrap.py": "from textkit.wrap import wrap\n",
      "textkit/wrap.py": "def wrap(s):\n    return s\n",
    });
    expect(await relatedTestFiles(root, ["textkit/slug.py"], null)).toEqual(["tests/test_slug.py"]);
    expect((await relatedTestFiles(root, ["textkit/wrap.py"], null))[0]).toBe("tests/test_wrap.py");
  });
});
