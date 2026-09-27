/**
 * `viberon mcp …` — the MCP marketplace from the command line.
 *
 *   viberon mcp list [--installed] [--category <c>] [--json]
 *   viberon mcp search <query> [--category <c>] [--json]
 *   viberon mcp install <id> [--set NAME=value]… [--yes] [--json]
 *   viberon mcp remove <id>
 *   viberon mcp enable|disable <id>
 *   viberon mcp test <id> [--timeout <sec>] [--repo <path>] [--json]
 *   --registry <https-url>   merge this registry index for this command only
 *
 * Values for an install come from `--set`, then from an environment
 * variable of the same name, then from an interactive prompt (hidden for
 * secrets). Prefer the environment or the prompt for secrets: `--set` ends
 * up in shell history. The plan is always printed; without `--yes` the
 * install asks for confirmation, and refuses when stdin is not a terminal.
 *
 * This module writes to the same store the app reads (see `cli/main.ts`),
 * so a server installed here shows up in Settings and vice versa.
 */

import path from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { CATEGORIES, loadCatalog, searchCatalog, type CatalogCategory, type CatalogEntry } from "@/lib/mcp/catalog";
import {
  getRegistryUrl,
  installServer,
  listInstalled,
  MarketplaceError,
  planInstall,
  setServerEnabled,
  testServer,
  uninstallServer,
  type InstallPlan,
} from "@/lib/mcp/marketplace";

export const MCP_ACTIONS = ["list", "search", "install", "remove", "enable", "disable", "test"] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

export interface McpArgs {
  command: "mcp";
  action: McpAction;
  target?: string;
  category?: CatalogCategory;
  installed: boolean;
  set: Record<string, string>;
  yes: boolean;
  json: boolean;
  timeoutSec?: number;
  registry?: string;
  repo?: string;
}

export const MCP_USAGE = `  viberon mcp list [--installed] [--category <c>] [--json]
  viberon mcp search <query> [--category <c>] [--json]
  viberon mcp install <id> [--set NAME=value]... [--yes] [--json]
      values come from --set, then $NAME, then a prompt (hidden for secrets)
  viberon mcp remove <id>          uninstall and delete its stored secrets
  viberon mcp enable|disable <id>
  viberon mcp test <id> [--timeout <sec>] [--repo <path>] [--json]
      --registry <https-url>       also list servers from this registry index`;

export class McpCliError extends Error {}

const BOOLEAN = new Set(["installed", "yes", "json", "help"]);
const VALUED = new Set(["category", "set", "timeout", "registry", "repo"]);

export function parseMcpArgs(argv: string[]): McpArgs | { command: "help" } {
  const [action, ...rest] = argv;
  if (!action || action === "help" || action === "--help" || action === "-h") return { command: "help" };
  if (!MCP_ACTIONS.includes(action as McpAction)) throw new McpCliError(`Unknown mcp action: ${action}`);
  const args: McpArgs = { command: "mcp", action: action as McpAction, installed: false, set: {}, yes: false, json: false };
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "-y") {
      args.yes = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN.has(name)) {
      if (name === "help") return { command: "help" };
      if (name === "installed") args.installed = true;
      if (name === "yes") args.yes = true;
      if (name === "json") args.json = true;
      continue;
    }
    if (!VALUED.has(name)) throw new McpCliError(`Unknown option for mcp: --${name}`);
    const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new McpCliError(`--${name} needs a value`);
    if (name === "set") {
      const at = value.indexOf("=");
      if (at <= 0) throw new McpCliError("--set takes NAME=value");
      args.set[value.slice(0, at)] = value.slice(at + 1);
    } else if (name === "category") {
      if (!CATEGORIES.includes(value as CatalogCategory)) {
        throw new McpCliError(`--category must be one of: ${CATEGORIES.join(", ")}`);
      }
      args.category = value as CatalogCategory;
    } else if (name === "timeout") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new McpCliError("--timeout must be a positive number of seconds");
      args.timeoutSec = n;
    } else if (name === "registry") args.registry = value;
    else if (name === "repo") args.repo = value;
  }

  if (action === "search") {
    if (positionals.length === 0) throw new McpCliError("mcp search: a query is required");
    args.target = positionals.join(" ");
  } else if (action !== "list") {
    if (positionals.length !== 1) throw new McpCliError(`mcp ${action}: exactly one server id is required`);
    args.target = positionals[0];
  }
  if (Object.keys(args.set).length > 0 && action !== "install") throw new McpCliError("--set is only for mcp install");
  return args;
}

/* ---------------------------------- io ------------------------------------ */

export interface McpIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Ask a question; `secret` hides the typed answer. Absent → non-interactive. */
  ask?: (question: string, secret: boolean) => Promise<string>;
  env: Record<string, string | undefined>;
}

function terminalAsk(question: string, secret: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stderr.write("\n");
      resolve(answer);
    });
    muted = secret;
  });
}

export function defaultIo(): McpIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    ...(process.stdin.isTTY ? { ask: terminalAsk } : {}),
    env: process.env,
  };
}

/* -------------------------------- output ---------------------------------- */

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length));

function entryLine(entry: CatalogEntry, installed: Map<string, boolean>): string {
  const state = installed.has(entry.id) ? (installed.get(entry.id) ? "installed" : "disabled") : "";
  return `${pad(entry.id, 22)}${pad(entry.category, 14)}${pad(entry.trust, 10)}${pad(state, 10)}${entry.description}\n`;
}

export function formatPlan(plan: InstallPlan): string {
  const lines = [`${plan.reinstall ? "Reconfigure" : "Install"} ${plan.displayName} (${plan.id}) — ${plan.trust}, by ${plan.publisher}`];
  lines.push(`  homepage: ${plan.homepage}`);
  if (plan.commandLine) lines.push(`  runs:     ${plan.commandLine}`);
  if (plan.url) lines.push(`  connects: ${plan.url} (${plan.transport})`);
  for (const [k, v] of Object.entries(plan.headers ?? {})) lines.push(`  header:   ${k}: ${v}`);
  for (const e of plan.env) lines.push(`  env:      ${e.name}=${e.value}${e.secret ? "  (secret)" : ""}`);
  if (plan.inheritedEnv.length) lines.push(`  inherits: ${plan.inheritedEnv.join(", ")} (not your API keys)`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  if (plan.missing.length) lines.push(`  missing:  ${plan.missing.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

/* --------------------------------- run ------------------------------------ */

async function collectValues(entry: CatalogEntry, args: McpArgs, io: McpIo, installedAlready: boolean): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of entry.fields) {
    const given = args.set[field.name] ?? io.env[field.name];
    if (given !== undefined && given !== "") {
      values[field.name] = given;
      continue;
    }
    // Reconfiguring keeps stored secrets and defaults; only ask for what is required and unknown.
    if (!field.required || field.default || (installedAlready && field.secret) || !io.ask) continue;
    values[field.name] = (await io.ask(`${field.label} (${field.name})${field.secret ? " [hidden]" : ""}: `, field.secret)).trim();
  }
  return values;
}

export async function runMcp(args: McpArgs, io: McpIo = defaultIo()): Promise<number> {
  try {
    const registryUrl = args.registry ?? (await getRegistryUrl());
    const catalog = await loadCatalog(registryUrl);
    if (catalog.registry.status === "error") io.err(`[viberon] registry unavailable (${catalog.registry.error}); using the bundled catalog\n`);
    const installed = await listInstalled();
    const installedMap = new Map(installed.map((s) => [s.catalogId, s.enabled]));
    const find = (id: string) => {
      const entry = catalog.entries.find((e) => e.id === id);
      if (!entry) throw new McpCliError(`No catalog entry "${id}". Try: viberon mcp search ${id}`);
      return entry;
    };

    switch (args.action) {
      case "list":
      case "search": {
        let entries = args.action === "search" ? searchCatalog(catalog.entries, args.target ?? "", args.category) : searchCatalog(catalog.entries, "", args.category);
        if (args.installed) entries = entries.filter((e) => installedMap.has(e.id));
        if (args.json) {
          io.out(`${JSON.stringify({ entries, installed, registry: catalog.registry }, null, 2)}\n`);
          return 0;
        }
        if (entries.length === 0) {
          io.err("[viberon] no matching servers\n");
          return 0;
        }
        for (const entry of entries) io.out(entryLine(entry, installedMap));
        return 0;
      }
      case "install": {
        const entry = find(args.target!);
        const values = await collectValues(entry, args, io, installedMap.has(entry.id));
        const plan = await planInstall(entry, values, catalog.registry.url);
        io.err(formatPlan(plan));
        if (plan.missing.length > 0) {
          io.err(`[viberon] missing ${plan.missing.join(", ")}: pass --set NAME=value or set the environment variable\n`);
          return 2;
        }
        if (!args.yes) {
          if (!io.ask) {
            io.err("[viberon] not a terminal: review the plan above and re-run with --yes to install\n");
            return 2;
          }
          const answer = (await io.ask("Install? [y/N] ", false)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") {
            io.err("[viberon] cancelled\n");
            return 1;
          }
        }
        const server = await installServer(entry, { values, confirm: true, planHash: plan.planHash, registryUrl: catalog.registry.url });
        if (args.json) io.out(`${JSON.stringify(server, null, 2)}\n`);
        else io.out(`installed ${server.name}. Test it with: viberon mcp test ${server.name}\n`);
        return 0;
      }
      case "remove": {
        const entry = catalog.entries.find((e) => e.id === args.target);
        await uninstallServer(args.target!, entry);
        io.out(`removed ${args.target}\n`);
        return 0;
      }
      case "enable":
      case "disable": {
        const server = await setServerEnabled(args.target!, args.action === "enable");
        io.out(`${server.name} ${server.enabled ? "enabled" : "disabled"}\n`);
        return 0;
      }
      case "test": {
        const cwd = args.repo ? path.resolve(args.repo) : process.cwd();
        io.err(`[viberon] starting ${args.target}…\n`);
        const result = await testServer(args.target!, {
          cwd,
          ...(args.timeoutSec ? { timeoutMs: args.timeoutSec * 1000 } : {}),
        });
        if (args.json) io.out(`${JSON.stringify(result, null, 2)}\n`);
        else if (result.ok) {
          io.out(`ok  ${result.serverInfo ? `${result.serverInfo.name} ${result.serverInfo.version}  ` : ""}${result.tools.length} tools  ${(result.durationMs / 1000).toFixed(1)}s\n`);
          for (const tool of result.tools) io.out(`  ${pad(tool.name, 28)}${tool.description.split("\n")[0]}\n`);
        } else {
          io.out(`failed: ${result.error ?? "unknown error"}\n`);
          for (const line of result.logs.slice(-15)) io.err(`  ${line}\n`);
        }
        return result.ok ? 0 : 1;
      }
    }
  } catch (error) {
    if (error instanceof McpCliError || error instanceof MarketplaceError) {
      io.err(`[viberon] ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
