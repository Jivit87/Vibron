/**
 * The registry glue: turn connected MCP servers into `ToolImpl`s that the
 * agent loop can call exactly like a built-in tool.
 *
 * Approval follows the shell policy. Under "ask", every call to a server
 * the user has not marked trusted goes through the same inline approval
 * prompt as an unusual shell command. Under "never", untrusted servers are
 * refused outright — the user turned off side effects they did not vet.
 */

import type { AiToolDef } from "@/lib/ai/types";
import {
  assignQualifiedNames,
  bridgeToolDef,
  formatToolResult,
  mcpAccessForRole,
  toolAllowedFor,
} from "@/lib/mcp/bridge";
import type { McpServerConfig } from "@/lib/mcp/config";
import { callServerTool, ensureConnected } from "@/lib/mcp/manager";
import { resolveServers } from "@/lib/mcp/settings";
import type { ToolContext, ToolImpl } from "@/lib/tools/registry";

export interface McpToolset {
  defs: AiToolDef[];
  tools: Record<string, ToolImpl>;
  /** Servers that failed to connect, for the trace. */
  failures: { name: string; error: string }[];
}

export const EMPTY_TOOLSET: McpToolset = { defs: [], tools: {}, failures: [] };

function previewArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 300 ? `${json.slice(0, 297)}…` : json;
}

export function makeMcpTool(
  scope: string,
  cwd: string | null,
  config: McpServerConfig,
  toolName: string,
  def: AiToolDef,
  call: typeof callServerTool = callServerTool,
): ToolImpl {
  return {
    def,
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!config.trusted) {
        if (ctx.commandPolicy === "never") {
          return `Refused: MCP server "${config.name}" is not trusted and tool execution is disabled in Settings. Mark the server trusted to allow it.`;
        }
        if (ctx.commandPolicy === "ask") {
          const approved = await ctx.events.requestApproval?.({
            kind: "mcp",
            title: def.name,
            reason: `MCP tool "${toolName}" on untrusted server "${config.name}"`,
            detail: { args: previewArgs(args) },
            alwaysKey: def.name,
          });
          if (!approved) {
            return `The user declined the MCP call \`${def.name}\`. Continue without it, or explain why it is necessary.`;
          }
        }
      }
      try {
        const result = await call(scope, config, cwd, toolName, args);
        return formatToolResult(result);
      } catch (error) {
        return `Error: MCP tool ${def.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

/**
 * Build a set from already-resolved configs. Split out from
 * `loadMcpToolset` so tests can drive it without the settings store.
 */
export async function buildToolset(
  scope: string,
  cwd: string | null,
  servers: McpServerConfig[],
  roleTools: string[],
): Promise<McpToolset> {
  const access = mcpAccessForRole(roleTools);
  if (access === "none") return EMPTY_TOOLSET;
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length === 0) return EMPTY_TOOLSET;

  const connections = await Promise.all(
    enabled.map(async (config) => ({ config, conn: await ensureConnected(scope, config, cwd) })),
  );

  const toolset: McpToolset = { defs: [], tools: {}, failures: [] };
  const taken = new Set<string>();
  for (const { config, conn } of connections) {
    if (conn.status !== "connected") {
      toolset.failures.push({ name: config.name, error: conn.error ?? conn.status });
      continue;
    }
    const allowed = conn.tools.filter((tool) => toolAllowedFor(access, tool));
    for (const { tool, qualified } of assignQualifiedNames(config.name, allowed, taken)) {
      const def = bridgeToolDef(config.name, tool, qualified);
      toolset.defs.push(def);
      toolset.tools[qualified] = makeMcpTool(scope, cwd, config, tool.name, def);
    }
  }
  return toolset;
}

/** Resolve config for a workspace and connect what a role may use. */
export async function loadMcpToolset(
  repoKey: string,
  rootPath: string | null,
  roleTools: string[],
): Promise<McpToolset> {
  const { servers } = await resolveServers(repoKey, rootPath);
  return buildToolset(repoKey, rootPath, servers, roleTools);
}
