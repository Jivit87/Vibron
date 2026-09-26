/**
 * Source-control API.
 *
 *   GET  /api/git?repoKey=…                       → status + branches + log
 *   GET  /api/git?repoKey=…&op=show&path=…&ref=HEAD|INDEX|WORKING
 *                                                  → file content at a revision
 *   POST /api/git  { repoKey, op, … }              → mutations (see below)
 *
 * Mutating ops: stage, unstage, discard (paths | all), commit (message),
 * switch / createBranch (name), init, fetch, pull, push, generateMessage.
 *
 * All git work happens through `execFile("git", argv)` in `lib/git` — no
 * shell. Paths and branch names are validated before they reach argv.
 */

import { readFile } from "node:fs/promises";

import {
  commit,
  discard,
  fetchRemote,
  getBranches,
  getLog,
  getStatus,
  GitCommandError,
  GitInputError,
  init,
  pull,
  push,
  repoState,
  resolveGitPaths,
  showFile,
  stage,
  stagedDiff,
  switchBranch,
  unstage,
} from "@/lib/git";
import { isValidBranchName } from "@/lib/git/parse";
import { openWorkspace, WorkspacePathError } from "@/lib/workspace";
import { resolveWorkspaceFilePath } from "@/lib/local-disk-workspace";

export const runtime = "nodejs";
export const maxDuration = 180;

type Resolved = { rootPath: string; response?: undefined } | { rootPath?: undefined; response: Response };

/** GitSnapshot for a workspace with no folder on disk. */
const VIRTUAL_SNAPSHOT = {
  virtual: true,
  isRepo: false,
  gitAvailable: false,
  parentRepo: null,
} as const;

async function resolveRoot(repoKey: unknown, forShow = false): Promise<Resolved> {
  if (typeof repoKey !== "string" || !repoKey) {
    return { response: Response.json({ error: "repoKey is required" }, { status: 400 }) };
  }
  const handle = await openWorkspace(repoKey);
  if (!handle.rootPath) {
    return { response: forShow ? Response.json({ error: "Not a git repository" }, { status: 400 }) : Response.json(VIRTUAL_SNAPSHOT) };
  }
  return { rootPath: handle.rootPath };
}

function errorResponse(error: unknown): Response {
  if (error instanceof GitInputError || error instanceof WorkspacePathError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof GitCommandError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "git failed" },
    { status: 500 },
  );
}

async function snapshot(rootPath: string) {
  const state = await repoState(rootPath);
  if (!state.isRepo) {
    return { virtual: false, ...state };
  }
  // Snapshot reads run in parallel; a failure in one surfaces as a 409.
  const [status, branches, log] = await Promise.all([
    getStatus(rootPath),
    getBranches(rootPath),
    getLog(rootPath, 30),
  ]);
  return { virtual: false, ...state, status, branches, log };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const isShow = url.searchParams.get("op") === "show";
  const resolved = await resolveRoot(url.searchParams.get("repoKey"), isShow);
  if (resolved.response) return resolved.response;
  const { rootPath } = resolved;

  try {
    if (isShow) {
      const filePath = url.searchParams.get("path") ?? "";
      const ref = url.searchParams.get("ref");
      const [rel] = resolveGitPaths(rootPath, [filePath]);
      if (ref === "WORKING") {
        const absolute = resolveWorkspaceFilePath(rootPath, rel);
        const content = await readFile(absolute, "utf8").catch(() => null);
        return Response.json({ path: rel, ref, content });
      }
      if (ref !== "HEAD" && ref !== "INDEX") {
        return Response.json({ error: "ref must be HEAD, INDEX or WORKING" }, { status: 400 });
      }
      const state = await repoState(rootPath);
      if (!state.isRepo) {
        return Response.json({ error: "Not a git repository" }, { status: 400 });
      }
      const content = await showFile(rootPath, rel, ref);
      return Response.json({ path: rel, ref, content });
    }

    return Response.json(await snapshot(rootPath));
  } catch (error) {
    return errorResponse(error);
  }
}

interface PostBody {
  repoKey?: unknown;
  op?: unknown;
  paths?: unknown;
  all?: unknown;
  message?: unknown;
  name?: unknown;
  model?: unknown;
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const resolved = await resolveRoot(body.repoKey);
  if (resolved.response) return resolved.response;
  const { rootPath } = resolved;
  const op = typeof body.op === "string" ? body.op : "";

  try {
    if (op === "init") {
      const state = await repoState(rootPath);
      if (state.isRepo) {
        return Response.json({ error: "Already a git repository" }, { status: 400 });
      }
      await init(rootPath);
      return Response.json(await snapshot(rootPath));
    }

    const state = await repoState(rootPath);
    if (!state.isRepo) {
      return Response.json({ error: "Not a git repository" }, { status: 400 });
    }

    const targets = (): string[] | "all" =>
      body.paths === "all" || body.all === true ? "all" : resolveGitPaths(rootPath, body.paths);

    let output = "";
    switch (op) {
      case "stage":
        await stage(rootPath, targets());
        break;
      case "unstage":
        await unstage(rootPath, targets());
        break;
      case "discard":
        await discard(rootPath, targets());
        break;
      case "commit": {
        if (typeof body.message !== "string") {
          return Response.json({ error: "message is required" }, { status: 400 });
        }
        output = await commit(rootPath, body.message);
        break;
      }
      case "switch":
      case "createBranch": {
        if (!isValidBranchName(body.name)) {
          return Response.json({ error: "Invalid branch name" }, { status: 400 });
        }
        await switchBranch(rootPath, body.name, op === "createBranch");
        break;
      }
      case "fetch":
        output = await fetchRemote(rootPath);
        break;
      case "pull":
        output = await pull(rootPath);
        break;
      case "push": {
        const status = await getStatus(rootPath);
        output = await push(rootPath, status.branch.upstream);
        break;
      }
      case "generateMessage": {
        const diff = await stagedDiff(rootPath);
        if (!diff.trim()) {
          return Response.json(
            { error: "Stage some changes first — the message is written from the staged diff." },
            { status: 400 },
          );
        }
        const { generateCommitMessage } = await import("@/lib/git/commit-message");
        const message = await generateCommitMessage(
          diff,
          typeof body.model === "string" ? body.model : "auto",
        );
        return Response.json({ message });
      }
      default:
        return Response.json({ error: `Unknown op: ${op || "(none)"}` }, { status: 400 });
    }

    return Response.json({ ...(await snapshot(rootPath)), output });
  } catch (error) {
    return errorResponse(error);
  }
}
