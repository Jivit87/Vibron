/**
 * Translation between MCP and Viberon's tool model.
 *
 * Pure functions only: naming, JSON-schema bridging, result flattening, and
 * the role-access rule. The connection manager and the registry glue build
 * on these.
 */

import { createHash } from "node:crypto";

import type { AiToolDef } from "@/lib/ai/types";

/** What an MCP server reports for one tool (subset of the spec's Tool). */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    title?: string;
  };
}

/** Providers cap tool names at 64 chars of [a-zA-Z0-9_-]. */
export const MAX_TOOL_NAME = 64;
export const MCP_PREFIX = "mcp__";

/** Make a string safe for the name charset, and free of `__` runs. */
export function sanitizeNamePart(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return cleaned || "x";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 6);
}

/**
 * `mcp__<server>__<tool>`, the Claude Code convention. `__` only ever
 * appears as the separator because each part has its runs collapsed. When
 * the result exceeds the provider limit the tool part is truncated and a
 * hash of the original pair appended, so two long names cannot collide.
 */
export function qualifiedToolName(server: string, tool: string): string {
  const s = sanitizeNamePart(server);
  const t = sanitizeNamePart(tool);
  const full = `${MCP_PREFIX}${s}__${t}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = shortHash(`${server}\u0000${tool}`);
  const serverPart = s.slice(0, 20);
  const room = MAX_TOOL_NAME - MCP_PREFIX.length - serverPart.length - 2 - hash.length - 1;
  return `${MCP_PREFIX}${serverPart}__${t.slice(0, Math.max(1, room))}_${hash}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** Keys that providers reject or that only add noise at the top level. */
const DROPPED_SCHEMA_KEYS = new Set(["$schema", "$id", "title"]);

/**
 * MCP input schemas are plain JSON Schema; providers want an object schema
 * with a `properties` map. Missing or malformed schemas degrade to "no
 * arguments" rather than failing the whole tool list.
 */
export function bridgeInputSchema(schema: unknown): AiToolDef["input_schema"] {
  const source =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!DROPPED_SCHEMA_KEYS.has(key) && key !== "type" && key !== "properties" && key !== "required") {
      rest[key] = value;
    }
  }
  const properties =
    source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? (source.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(source.required)
    ? source.required.filter((r): r is string => typeof r === "string" && r in properties)
    : [];
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  } as AiToolDef["input_schema"];
}

const MAX_DESCRIPTION = 1024;

export function bridgeToolDef(serverName: string, tool: McpToolInfo, qualified: string): AiToolDef {
  const base = (tool.description || tool.title || tool.annotations?.title || tool.name).trim();
  const readOnly = tool.annotations?.readOnlyHint === true ? " (read-only)" : "";
  const description = `[MCP server "${serverName}"${readOnly}] ${base}`;
  return {
    name: qualified,
    description:
      description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    input_schema: bridgeInputSchema(tool.inputSchema),
  };
}

/**
 * Assign qualified names for one server's tools, suffixing on the rare
 * collision (two tools that sanitize to the same name).
 */
export function assignQualifiedNames(
  server: string,
  tools: McpToolInfo[],
  taken: Set<string> = new Set(),
): { tool: McpToolInfo; qualified: string }[] {
  return tools.map((tool) => {
    let name = qualifiedToolName(server, tool.name);
    if (taken.has(name)) {
      const base = name.slice(0, MAX_TOOL_NAME - 3);
      let i = 2;
      while (taken.has(`${base}_${i}`)) i += 1;
      name = `${base}_${i}`;
    }
    taken.add(name);
    return { tool, qualified: name };
  });
}

/* ----------------------------- role access -------------------------------- */

export type McpAccess = "all" | "readonly" | "none";

/**
 * Which MCP tools a role may see. Roles that can write (every build role)
 * get everything. Roles that cannot write — the question-answering
 * assistant and the reviewer — only get tools the server annotates as
 * read-only, which preserves the guarantee that asking a question never
 * changes anything.
 */
export function mcpAccessForRole(roleTools: string[]): McpAccess {
  if (roleTools.includes("write_file") || roleTools.includes("edit_file")) return "all";
  return "readonly";
}

export function toolAllowedFor(access: McpAccess, tool: McpToolInfo): boolean {
  if (access === "none") return false;
  if (access === "all") return true;
  return tool.annotations?.readOnlyHint === true;
}

/* ------------------------------- results ---------------------------------- */

export const MAX_RESULT_CHARS = 40_000;

type ContentBlock = Record<string, unknown> & { type?: string };

function approxBytes(base64: unknown): string {
  if (typeof base64 !== "string") return "?";
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes > 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return String(block.text ?? "");
    case "image":
      return `[image: ${String(block.mimeType ?? "unknown")}, ${approxBytes(block.data)} — binary content not shown to the model]`;
    case "audio":
      return `[audio: ${String(block.mimeType ?? "unknown")}, ${approxBytes(block.data)} — not shown]`;
    case "resource": {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      const uri = String(resource.uri ?? "");
      if (typeof resource.text === "string") return `Resource ${uri}:\n${resource.text}`;
      return `[binary resource ${uri} (${String(resource.mimeType ?? "unknown")}, ${approxBytes(resource.blob)})]`;
    }
    case "resource_link":
      return `[resource link: ${String(block.name ?? block.title ?? "")} ${String(block.uri ?? "")}]`.replace(/\s+\]/, "]");
    default:
      return JSON.stringify(block);
  }
}

/**
 * Flatten a CallToolResult into the single string the agent loop carries.
 * Errors are prefixed with "Error:" so the runner flags them as failures.
 */
export function formatToolResult(result: unknown): string {
  const r = (result && typeof result === "object" ? result : {}) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
    toolResult?: unknown;
  };
  let text: string;
  if (Array.isArray(r.content) && r.content.length > 0) {
    text = (r.content as ContentBlock[]).map(renderBlock).join("\n");
  } else if (r.structuredContent !== undefined) {
    text = JSON.stringify(r.structuredContent, null, 2);
  } else if (r.toolResult !== undefined) {
    // Protocol 2024-10-07 compatibility shape.
    text = typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult);
  } else {
    text = "(no output)";
  }
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${text.length - MAX_RESULT_CHARS} chars]`;
  }
  return r.isError ? `Error: ${text}` : text;
}
