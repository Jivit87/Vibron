/**
 * Workspace hook trust.
 *
 * A hooks file inside a repository is code written by whoever wrote the
 * repository. Cloning an arbitrary repo is a core Viberon flow, so its
 * hooks must never run until the user approves them. Approval is recorded
 * per workspace (its real path) *and* per file hash: any change to the
 * file — a pull, a branch switch, an agent edit — revokes it.
 *
 * The record lives in the user's settings directory
 * (`~/.viberon/hooks-trust.json`), not in the repo and not in the app's
 * data store, so the desktop app and the `viberon` CLI (which runs with an
 * in-memory store) share one set of decisions. Nothing a repository ships
 * can mark itself trusted.
 */

import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { configDir } from "@/lib/hooks/config";

export const TRUST_FILE = "hooks-trust.json";

export interface TrustRecord {
  hash: string;
  approvedAt: string;
}

interface TrustDoc {
  version: 1;
  workspaces: Record<string, TrustRecord>;
}

export type TrustState = "trusted" | "untrusted" | "changed";

function trustPath(): string | null {
  const dir = configDir();
  return dir ? path.join(dir, TRUST_FILE) : null;
}

/** The identity of a workspace: its resolved real path. */
export function workspaceId(root: string): string {
  const resolved = path.resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function readDoc(): Promise<TrustDoc> {
  const file = trustPath();
  if (!file) return { version: 1, workspaces: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TrustDoc>;
    const workspaces: Record<string, TrustRecord> = {};
    for (const [key, value] of Object.entries(parsed.workspaces ?? {})) {
      if (value && typeof value.hash === "string" && /^[0-9a-f]{64}$/.test(value.hash)) {
        workspaces[key] = { hash: value.hash, approvedAt: String(value.approvedAt ?? "") };
      }
    }
    return { version: 1, workspaces };
  } catch {
    return { version: 1, workspaces: {} };
  }
}

async function writeDoc(doc: TrustDoc): Promise<void> {
  const file = trustPath();
  if (!file) throw new Error("No user settings directory is available to store hook trust (set VIBERON_CONFIG_DIR).");
  await mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename: a crash mid-write never leaves a half-parsed file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

export async function getTrustRecord(root: string): Promise<TrustRecord | null> {
  return (await readDoc()).workspaces[workspaceId(root)] ?? null;
}

/** Whether the hooks file with `hash` is approved for the workspace at `root`. */
export async function trustStateFor(root: string, hash: string | null): Promise<TrustState> {
  const record = await getTrustRecord(root);
  if (!record) return "untrusted";
  return hash && record.hash === hash ? "trusted" : "changed";
}

/** Approve exactly this version (hash) of the workspace's hooks file. */
export async function trustWorkspaceHooks(root: string, hash: string): Promise<TrustRecord> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("A sha256 hooks-file hash is required.");
  const doc = await readDoc();
  const record = { hash, approvedAt: new Date().toISOString() };
  doc.workspaces[workspaceId(root)] = record;
  await writeDoc(doc);
  return record;
}

export async function revokeWorkspaceHooks(root: string): Promise<boolean> {
  const doc = await readDoc();
  const id = workspaceId(root);
  if (!doc.workspaces[id]) return false;
  delete doc.workspaces[id];
  await writeDoc(doc);
  return true;
}
