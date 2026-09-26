/**
 * Execution environment for a repository's own commands (ported from
 * Pramana `tools/shell.py`): activate the repo's virtualenv, bridge
 * `python` → `python3` when only python3 exists, put the repo (and `src/`)
 * on PYTHONPATH, make every tool non-interactive, and never pass API keys
 * to repo code.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scrubEnv } from "@/lib/terminal/safety";

const VENV_NAMES = [".venv", "venv", "env", ".env", path.join(".viberon", "venv")];

export function findRepoVenv(root: string): string | null {
  for (const name of VENV_NAMES) {
    const candidate = path.join(root, name);
    if (
      existsSync(path.join(candidate, "bin", "python")) ||
      existsSync(path.join(candidate, "Scripts", "python.exe"))
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Automatically provisions an isolated venv in `.viberon/venv` if none exists
 * and the repository provides python dependency descriptors (requirements.txt / pyproject.toml).
 */
export async function ensureRepoVenv(
  root: string,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  const existing = findRepoVenv(root);
  if (existing) return existing;

  const hasReqs = existsSync(path.join(root, "requirements.txt"));
  const hasPyproject = existsSync(path.join(root, "pyproject.toml"));
  const hasSetup = existsSync(path.join(root, "setup.py"));

  if (!hasReqs && !hasPyproject && !hasSetup) return null;

  const env = buildRepoEnv(root);
  const sysPython = which("python3", env.PATH) ?? which("python", env.PATH);
  if (!sysPython) return null;

  const targetVenv = path.join(root, ".viberon", "venv");
  try {
    mkdirSync(path.join(root, ".viberon"), { recursive: true });
    const create = spawnSync(sysPython, ["-m", "venv", targetVenv], {
      cwd: root,
      timeout: opts?.timeoutMs ?? 60_000,
      stdio: "ignore",
    });
    if (create.status !== 0) return null;

    const venvPip = path.join(
      targetVenv,
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "pip.exe" : "pip",
    );

    if (existsSync(venvPip) && hasReqs) {
      spawnSync(venvPip, ["install", "--no-input", "--disable-pip-version-check", "-r", "requirements.txt"], {
        cwd: root,
        timeout: opts?.timeoutMs ?? 180_000,
        stdio: "ignore",
      });
    }

    return targetVenv;
  } catch {
    return null;
  }
}

/** First match for `name` on a PATH string, or null. */
export function which(name: string, pathValue = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Directory holding a `python` symlink to python3 when PATH has no `python`. */
function pythonShimDir(pathValue: string): string | null {
  if (which("python", pathValue)) return null;
  const py3 = which("python3", pathValue);
  if (!py3) return null;
  const dir = path.join(os.tmpdir(), "viberon-python-shim");
  const link = path.join(dir, "python");
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(link)) symlinkSync(py3, link);
    return dir;
  } catch {
    return null;
  }
}

/** Directories to put in front of PATH for this repo (venv bin, python shim). */
export function repoPathPrefix(root: string, basePath = process.env.PATH ?? ""): string[] {
  const prefix: string[] = [];
  const venv = findRepoVenv(root);
  if (venv) {
    prefix.push(path.join(venv, process.platform === "win32" ? "Scripts" : "bin"));
  }
  const shim = pythonShimDir([...prefix, basePath].join(path.delimiter));
  if (shim) prefix.push(shim);
  return prefix;
}

/** Full environment for running repo commands (tests, installs, probes). */
export function buildRepoEnv(
  root: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const base = scrubEnv(process.env) as Record<string, string>;
  delete base.PYTHONHOME;
  delete base.__PYVENV_LAUNCHER__;
  const venv = findRepoVenv(root);
  const prefix = repoPathPrefix(root, base.PATH ?? "");
  const pythonPath = [root];
  if (existsSync(path.join(root, "src")) && !existsSync(path.join(root, "src", "__init__.py"))) {
    pythonPath.unshift(path.join(root, "src"));
  }
  if (base.PYTHONPATH) pythonPath.push(base.PYTHONPATH);
  const env: Record<string, string> = {
    ...base,
    PATH: [...prefix, base.PATH ?? ""].filter(Boolean).join(path.delimiter),
    PYTHONPATH: pythonPath.join(path.delimiter),
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    EDITOR: "true",
    TERM: "dumb",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    PYTHONUNBUFFERED: "1",
    // Never leave .pyc files in the user's repo, and never read a stale one.
    PYTHONDONTWRITEBYTECODE: "1",
    DEBIAN_FRONTEND: "noninteractive",
    ...extra,
  };
  if (venv) env.VIRTUAL_ENV = venv;
  return env;
}

/**
 * Shell prelude that re-applies the repo PATH prefix. Needed when a command
 * runs through a login shell, whose profile can reorder PATH.
 */
export function repoEnvPrelude(root: string): string {
  const prefix = repoPathPrefix(root);
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const parts = [`export PYTHONDONTWRITEBYTECODE=1`];
  if (prefix.length) parts.push(`export PATH=${quote(prefix.join(path.delimiter))}:"$PATH"`);
  const venv = findRepoVenv(root);
  if (venv) parts.push(`export VIRTUAL_ENV=${quote(venv)}`);
  return `${parts.join("; ")}; `;
}
