/**
 * Environment bootstrap for repositories Viberon cloned itself (ported from
 * Pramana `repo/bootstrap.py`). Best effort and time-boxed: the goal is only
 * that the project's tests *can run*, because without runnable tests there
 * is no evidence. Every command goes through the terminal safety classifier.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { classifyCommand } from "@/lib/terminal/safety";
import { excludeFromGit } from "@/lib/workspace/graph-index";
import { execInRepo, findRepoVenv, which } from "@/lib/verify";

export interface BootstrapOptions {
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function declaresExtra(root: string, name: string): boolean {
  for (const file of ["pyproject.toml", "setup.cfg", "setup.py"]) {
    try {
      const text = readFileSync(path.join(root, file), "utf8");
      if (new RegExp(`(^|[\\s"'\\[,])${name}\\s*[=:\\]"']`, "m").test(text)) return true;
    } catch {
      // Missing file.
    }
  }
  return false;
}

export async function bootstrapEnvironment(root: string, options: BootstrapOptions = {}): Promise<string[]> {
  const notes: string[] = [];
  const progress = options.onProgress ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  const run = async (command: string, what: string): Promise<boolean> => {
    const verdict = classifyCommand(command);
    if (verdict.allowed === false) {
      notes.push(`${what}: refused (${verdict.reason})`);
      return false;
    }
    progress(`$ ${command}`);
    const result = await execInRepo(root, command, { timeoutMs, signal: options.signal });
    const ok = result.exitCode === 0 && !result.timedOut;
    const last = result.output.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
    notes.push(`${what}: ${ok ? "ok" : result.timedOut ? "timed out" : `failed (${last})`}`);
    progress(`${what}: ${ok ? "ok" : "failed"}`);
    return ok;
  };

  const has = (file: string) => existsSync(path.join(root, file));
  const pyProject = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"].some(has);
  if (pyProject && !findRepoVenv(root)) {
    const python = which("python3") ? "python3" : which("python") ? "python" : null;
    if (!python) {
      notes.push("python: not found on PATH");
    } else if (await run(`${python} -m venv .venv`, "create .venv")) {
      await excludeFromGit(root, "/.venv/").catch(() => false);
      const pip = ".venv/bin/python -m pip install -q";
      let installed = false;
      for (const extra of ["test", "tests", "testing", "dev"]) {
        if (declaresExtra(root, extra)) {
          installed = await run(`${pip} -e '.[${extra}]'`, `pip install -e .[${extra}]`);
          if (installed) break;
        }
      }
      if (!installed && ["pyproject.toml", "setup.py", "setup.cfg"].some(has)) {
        await run(`${pip} -e .`, "pip install -e .");
      }
      for (const req of [
        "requirements.txt",
        "requirements-dev.txt",
        "requirements-test.txt",
        "requirements_test.txt",
        "test-requirements.txt",
        "requirements/test.txt",
        "requirements/dev.txt",
      ]) {
        if (has(req)) await run(`${pip} -r ${req}`, `pip install -r ${req}`);
      }
      await run(`${pip} pytest`, "pip install pytest");
    }
  }

  if (has("package.json") && !has("node_modules")) {
    const command = has("pnpm-lock.yaml") && which("pnpm")
      ? "pnpm install --frozen-lockfile"
      : has("yarn.lock") && which("yarn")
        ? "yarn install --frozen-lockfile"
        : has("package-lock.json")
          ? "npm ci --no-audit --no-fund"
          : "npm install --no-audit --no-fund";
    await run(command, "node dependencies");
  }
  return notes;
}
