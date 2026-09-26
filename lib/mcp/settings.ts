/**
 * Where MCP configuration lives, and how the effective list is resolved.
 *
 *  - The user-global list sits in the same server-side settings store as
 *    provider keys (it can hold tokens in `env`/`headers`, so it never goes
 *    to the browser unredacted).
 *  - Per-workspace decisions (enable / trust a server that a project file
 *    defines) sit next to it, keyed by repoKey.
 *  - Project servers are read from the workspace's config files on every
 *    resolve, so edits to `.mcp.json` take effect on the next run.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyOverrides,
  mergeServerLists,
  parseMcpConfig,
  readWorkspaceMcpFiles,
  type McpServerConfig,
  type RawServerEntry,
  type ServerOverride,
  type WorkspaceConfigRead,
} from "@/lib/mcp/config";

const GLOBAL_KEY = "mcp:global-servers";
const overridesKey = (repoKey: string) => `mcp:overrides:${repoKey}`;

type StoreModule = typeof import("@/lib/store");
let storePromise: Promise<StoreModule> | null = null;
function store(): Promise<StoreModule> {
  if (!storePromise) storePromise = import("@/lib/store");
  return storePromise;
}

export async function getGlobalEntries(): Promise<Record<string, RawServerEntry>> {
  const { getValueRaw } = await store();
  return (await getValueRaw<Record<string, RawServerEntry>>(GLOBAL_KEY)) ?? {};
}

export async function setGlobalEntry(name: string, entry: RawServerEntry | null): Promise<void> {
  const { setValueRaw } = await store();
  const all = { ...(await getGlobalEntries()) };
  if (entry) all[name] = entry;
  else delete all[name];
  await setValueRaw(GLOBAL_KEY, all);
}

export async function getOverrides(repoKey: string): Promise<Record<string, ServerOverride>> {
  const { getValueRaw } = await store();
  return (await getValueRaw<Record<string, ServerOverride>>(overridesKey(repoKey))) ?? {};
}

export async function setOverride(
  repoKey: string,
  name: string,
  patch: ServerOverride | null,
): Promise<void> {
  const { setValueRaw } = await store();
  const all = { ...(await getOverrides(repoKey)) };
  // Decisions made about a different config (fingerprint) do not carry over.
  const prior =
    patch?.fingerprint && all[name]?.fingerprint !== patch.fingerprint ? {} : all[name];
  if (patch) all[name] = { ...prior, ...patch };
  else delete all[name];
  await setValueRaw(overridesKey(repoKey), all);
}

export interface ResolvedServers {
  servers: McpServerConfig[];
  files: WorkspaceConfigRead["files"];
  globalErrors: string[];
}

/** The effective, merged, override-applied server list for a workspace. */
export async function resolveServers(
  repoKey: string,
  rootPath: string | null,
): Promise<ResolvedServers> {
  const workspace: WorkspaceConfigRead = rootPath
    ? await readWorkspaceMcpFiles(rootPath)
    : { servers: [], files: [] };
  const global = parseMcpConfig({ mcpServers: await getGlobalEntries() }, "global");
  const merged = mergeServerLists(workspace.servers, global.servers);
  const overrides = repoKey ? await getOverrides(repoKey) : {};
  return {
    servers: applyOverrides(merged, overrides),
    files: workspace.files,
    globalErrors: global.errors,
  };
}

/* ---------------------- .viberon/mcp.json editing ------------------------- */

const VIBERON_FILE = ".viberon/mcp.json";

async function readViberonDoc(rootPath: string): Promise<{ mcpServers: Record<string, RawServerEntry> }> {
  try {
    const parsed = JSON.parse(await readFile(path.join(rootPath, VIBERON_FILE), "utf8")) as {
      mcpServers?: Record<string, RawServerEntry>;
    };
    return { ...parsed, mcpServers: { ...(parsed.mcpServers ?? {}) } };
  } catch {
    return { mcpServers: {} };
  }
}

export async function setWorkspaceEntry(
  rootPath: string,
  name: string,
  entry: RawServerEntry | null,
): Promise<void> {
  const doc = await readViberonDoc(rootPath);
  if (entry) doc.mcpServers[name] = entry;
  else delete doc.mcpServers[name];
  const file = path.join(rootPath, VIBERON_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}
