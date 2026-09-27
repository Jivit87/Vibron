/**
 * hooks.json: locations, parsing and hashing.
 *
 *   <workspace>/.viberon/hooks.json   project hooks (need trust, see ./trust)
 *   ~/.viberon/hooks.json             the user's own hooks (always active)
 *
 * The schema is Claude Code's, plus a flat shorthand:
 *
 *   { "hooks": { "PreToolUse": [
 *       { "matcher": "run_command", "hooks": [{ "type": "command", "command": "./guard.sh", "timeout": 10 }] },
 *       { "matcher": "edit_file|write_file", "command": "npx prettier --check ." }
 *   ] } }
 *
 * `timeout` is in seconds. `VIBERON_CONFIG_DIR` moves the user directory;
 * under vitest the real home is never read unless it is set.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileMatcher } from "@/lib/hooks/matcher";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  MAX_HOOK_TIMEOUT_MS,
  TOOL_EVENTS,
  type CommandHook,
  type HookEventName,
} from "@/lib/hooks/types";

export const WORKSPACE_HOOKS_FILE = ".viberon/hooks.json";
export const GLOBAL_HOOKS_FILE = "hooks.json";

/** The user-level Viberon directory, or null when there is none to use (tests). */
export function configDir(): string | null {
  const override = process.env.VIBERON_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  if (process.env.VITEST) return null;
  return path.join(os.homedir(), ".viberon");
}

export function globalHooksPath(): string | null {
  const dir = configDir();
  return dir ? path.join(dir, GLOBAL_HOOKS_FILE) : null;
}

export function workspaceHooksPath(root: string): string {
  return path.join(root, WORKSPACE_HOOKS_FILE);
}

export function hashHooksFile(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface ParsedHooksFile {
  hooks: CommandHook[];
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function timeoutOf(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.min(Math.round(raw * 1000), MAX_HOOK_TIMEOUT_MS);
}

/** Parse a hooks.json document (text or decoded). Never throws. */
export function parseHooksConfig(input: unknown, source: CommandHook["source"]): ParsedHooksFile {
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (error) {
      return { hooks: [], errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  if (!isRecord(doc)) return { hooks: [], errors: ["hooks file must be a JSON object"] };
  const map = doc.hooks;
  if (map === undefined) return { hooks: [], errors: [] };
  if (!isRecord(map)) return { hooks: [], errors: ['"hooks" must be an object keyed by event name'] };

  const hooks: CommandHook[] = [];
  const errors: string[] = [];
  for (const [eventName, entries] of Object.entries(map)) {
    if (!HOOK_EVENTS.includes(eventName as HookEventName)) {
      errors.push(`unknown hook event "${eventName}" (expected one of ${HOOK_EVENTS.join(", ")})`);
      continue;
    }
    const event = eventName as HookEventName;
    if (!Array.isArray(entries)) {
      errors.push(`${event}: must be an array of matcher entries`);
      continue;
    }
    entries.forEach((entry, i) => {
      if (!isRecord(entry)) {
        errors.push(`${event}[${i}]: entry must be an object`);
        return;
      }
      const matcher = typeof entry.matcher === "string" && entry.matcher.trim() ? entry.matcher.trim() : undefined;
      if (matcher && TOOL_EVENTS.has(event)) {
        const compiled = compileMatcher(matcher);
        if (compiled.error) {
          errors.push(`${event}[${i}]: ${compiled.error}`);
          return;
        }
      }
      // Either `{ matcher, hooks: [...] }` or the flat `{ matcher, command }`.
      const list: unknown[] = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      list.forEach((hook, j) => {
        if (!isRecord(hook)) {
          errors.push(`${event}[${i}].hooks[${j}]: must be an object`);
          return;
        }
        if (hook.type !== undefined && hook.type !== "command") {
          errors.push(`${event}[${i}].hooks[${j}]: unsupported type "${String(hook.type)}" (only "command")`);
          return;
        }
        const command = typeof hook.command === "string" ? hook.command.trim() : "";
        if (!command) {
          errors.push(`${event}[${i}].hooks[${j}]: "command" is required`);
          return;
        }
        hooks.push({
          kind: "command",
          id: `${source}:${event}:${i}.${j}`,
          source,
          event,
          ...(matcher && TOOL_EVENTS.has(event) ? { matcher } : {}),
          command,
          timeoutMs: timeoutOf(hook.timeout ?? entry.timeout),
        });
      });
    });
  }
  return { hooks, errors };
}

export interface HooksFileRead extends ParsedHooksFile {
  path: string;
  exists: boolean;
  /** sha256 of the raw file bytes; null when the file does not exist. */
  hash: string | null;
}

export async function readHooksFile(file: string, source: CommandHook["source"]): Promise<HooksFileRead> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { path: file, exists: false, hash: null, hooks: [], errors: [] };
    return {
      path: file,
      exists: true,
      hash: null,
      hooks: [],
      errors: [`could not read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  return { path: file, exists: true, hash: hashHooksFile(raw), ...parseHooksConfig(raw, source) };
}
