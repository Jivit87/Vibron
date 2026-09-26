/**
 * Language Server Protocol integration for real compiler diagnostics.
 *
 * Inspired by OpenCode's LSP integration: instead of only running a
 * lint gate after edits (which catches syntax errors), this module
 * feeds actual compiler diagnostics — type errors, unresolved imports,
 * unused variables, deprecation warnings — into the agent loop.
 *
 * The agent sees real diagnostic messages after every edit, making it
 * dramatically more effective at catching mistakes before calling
 * `finish`. This is the single highest-impact feature from OpenCode
 * that Viberon was missing.
 *
 * Architecture:
 *  - Manages LSP server processes for TypeScript (tsserver) and Python
 *    (pyright/pylsp) — the two most common languages in agent tasks.
 *  - Servers are started lazily on first edit of a file with that
 *    language, and shut down when the workspace closes.
 *  - After each edit, diagnostics for the changed file (and its
 *    dependents) are collected and returned as part of the tool
 *    result, so the model sees them immediately.
 *  - Diagnostics are formatted as a compact, actionable summary
 *    (file:line: severity: message) that fits in the agent's context
 *    without wasting tokens on JSON-RPC noise.
 *
 * Supported servers:
 *  - TypeScript: uses `tsserver` (bundled with TypeScript) or
 *    `typescript-language-server` if available.
 *  - Python: uses `pyright` (recommended) or `pylsp`.
 *  - Go: uses `gopls` if available.
 *  - Rust: uses `rust-analyzer` if available.
 *
 * Integration point: the tool registry calls `getDiagnosticsAfterEdit`
 * after a successful file edit and appends the result to the tool output.
 */

import { spawn, type ChildProcess, execSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

/* -------------------------------- types ---------------------------------- */

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
  source: string;
  code?: string | number;
}

export interface LspServerConfig {
  language: string;
  /** Command to start the server. */
  command: string;
  args: string[];
  /** File extensions this server handles. */
  extensions: string[];
}

interface LspConnection {
  process: ChildProcess;
  config: LspServerConfig;
  /** Pending diagnostics by file URI. */
  diagnostics: Map<string, Diagnostic[]>;
  /** JSON-RPC message ID counter. */
  nextId: number;
  /** Pending requests. */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Whether the server has been initialized. */
  initialized: boolean;
  /** Buffer for incoming data (messages may arrive in fragments). */
  buffer: string;
}

/* ----------------------------- detection --------------------------------- */

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which language servers are available on the system.
 */
export function detectAvailableServers(): LspServerConfig[] {
  const servers: LspServerConfig[] = [];

  // TypeScript.
  if (which("typescript-language-server")) {
    servers.push({
      language: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    });
  }

  // Python.
  if (which("pyright-langserver")) {
    servers.push({
      language: "python",
      command: "pyright-langserver",
      args: ["--stdio"],
      extensions: [".py", ".pyi"],
    });
  } else if (which("pylsp")) {
    servers.push({
      language: "python",
      command: "pylsp",
      args: [],
      extensions: [".py", ".pyi"],
    });
  }

  // Go.
  if (which("gopls")) {
    servers.push({
      language: "go",
      command: "gopls",
      args: ["serve", "-rpc.trace"],
      extensions: [".go"],
    });
  }

  // Rust.
  if (which("rust-analyzer")) {
    servers.push({
      language: "rust",
      command: "rust-analyzer",
      args: [],
      extensions: [".rs"],
    });
  }

  return servers;
}

/* ----------------------------- LSP client -------------------------------- */

/**
 * Lightweight LSP client that speaks JSON-RPC 2.0 over stdio.
 * Implements only the subset needed for diagnostic collection:
 *   - initialize / initialized
 *   - textDocument/didOpen
 *   - textDocument/didChange
 *   - textDocument/didSave
 *   - textDocument/publishDiagnostics (notification handler)
 *   - shutdown / exit
 */

function encodeMessage(content: string): string {
  const body = Buffer.from(content, "utf8");
  return `Content-Length: ${body.length}\r\n\r\n${content}`;
}

function fileUri(filePath: string): string {
  return `file://${path.resolve(filePath)}`;
}

function severityToString(severity: number): DiagnosticSeverity {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

/**
 * The main LSP manager. One per workspace.
 */
export class LspManager {
  private root: string;
  private connections: Map<string, LspConnection> = new Map();
  private availableServers: LspServerConfig[];
  private openFiles: Set<string> = new Set();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.availableServers = detectAvailableServers();
  }

  /** Which languages have a server available. */
  get supportedLanguages(): string[] {
    return this.availableServers.map((s) => s.language);
  }

  /** Whether any LSP server is available. */
  get hasServers(): boolean {
    return this.availableServers.length > 0;
  }

  /** Find the server config for a file extension. */
  private serverForFile(filePath: string): LspServerConfig | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.availableServers.find((s) => s.extensions.includes(ext));
  }

  /** Start an LSP server if not already running. */
  private async ensureConnection(config: LspServerConfig): Promise<LspConnection | null> {
    const existing = this.connections.get(config.language);
    if (existing && existing.initialized) return existing;
    if (existing) return null; // Starting.

    try {
      const child = spawn(config.command, config.args, {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
      });

      const connection: LspConnection = {
        process: child,
        config,
        diagnostics: new Map(),
        nextId: 1,
        pending: new Map(),
        initialized: false,
        buffer: "",
      };

      this.connections.set(config.language, connection);

      // Parse incoming messages.
      child.stdout?.on("data", (data: Buffer) => {
        this.handleData(connection, data.toString("utf8"));
      });

      child.stderr?.on("data", () => {
        // LSP servers sometimes log to stderr; ignore.
      });

      child.on("error", () => {
        this.connections.delete(config.language);
      });

      child.on("exit", () => {
        this.connections.delete(config.language);
      });

      // Initialize.
      await this.sendRequest(connection, "initialize", {
        processId: process.pid,
        rootUri: fileUri(this.root),
        rootPath: this.root,
        capabilities: {
          textDocument: {
            publishDiagnostics: {
              relatedInformation: false,
              tagSupport: { valueSet: [1, 2] },
            },
            synchronization: {
              didSave: true,
              willSave: false,
              willSaveWaitUntil: false,
            },
          },
          workspace: {
            workspaceFolders: true,
          },
        },
        workspaceFolders: [
          { uri: fileUri(this.root), name: path.basename(this.root) },
        ],
      });

      this.sendNotification(connection, "initialized", {});
      connection.initialized = true;

      return connection;
    } catch {
      this.connections.delete(config.language);
      return null;
    }
  }

  /** Parse LSP JSON-RPC messages from the stream. */
  private handleData(connection: LspConnection, data: string): void {
    connection.buffer += data;

    while (true) {
      const headerEnd = connection.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerPart = connection.buffer.slice(0, headerEnd);
      const match = headerPart.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        connection.buffer = connection.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (connection.buffer.length < bodyStart + contentLength) break;

      const body = connection.buffer.slice(bodyStart, bodyStart + contentLength);
      connection.buffer = connection.buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        this.handleMessage(connection, message);
      } catch {
        // Malformed JSON; skip.
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessage(connection: LspConnection, message: any): void {
    // Response to a request.
    if (message.id !== undefined && connection.pending.has(message.id)) {
      const { resolve, reject } = connection.pending.get(message.id)!;
      connection.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }

    // Notification: textDocument/publishDiagnostics.
    if (message.method === "textDocument/publishDiagnostics") {
      const uri: string = message.params?.uri ?? "";
      const rawDiagnostics: unknown[] = message.params?.diagnostics ?? [];
      const filePath = uri.replace("file://", "");
      const relative = path.relative(this.root, filePath);

      const diagnostics: Diagnostic[] = rawDiagnostics.map((d: unknown) => {
        const diag = d as {
          range: { start: { line: number; character: number }; end: { line: number; character: number } };
          severity?: number;
          message: string;
          source?: string;
          code?: string | number;
        };
        return {
          file: relative,
          line: (diag.range?.start?.line ?? 0) + 1,
          column: (diag.range?.start?.character ?? 0) + 1,
          endLine: diag.range?.end ? diag.range.end.line + 1 : undefined,
          endColumn: diag.range?.end ? diag.range.end.character + 1 : undefined,
          severity: severityToString(diag.severity ?? 3),
          message: diag.message,
          source: diag.source ?? connection.config.language,
          code: diag.code,
        };
      });

      connection.diagnostics.set(relative, diagnostics);
    }
  }

  private sendRequest(connection: LspConnection, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = connection.nextId++;
      connection.pending.set(id, { resolve, reject });
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      connection.process.stdin?.write(encodeMessage(message));

      // Timeout after 30 seconds.
      setTimeout(() => {
        if (connection.pending.has(id)) {
          connection.pending.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  private sendNotification(connection: LspConnection, method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    connection.process.stdin?.write(encodeMessage(message));
  }

  /* ----------------------- public API ------------------------------------ */

  /**
   * Notify the LSP server that a file was opened or changed.
   * Call this after a successful file edit.
   */
  async notifyFileChanged(filePath: string, content: string): Promise<void> {
    const config = this.serverForFile(filePath);
    if (!config) return;

    const connection = await this.ensureConnection(config);
    if (!connection) return;

    const uri = fileUri(path.resolve(this.root, filePath));
    const languageId = config.language === "typescript"
      ? (filePath.endsWith(".tsx") ? "typescriptreact"
        : filePath.endsWith(".jsx") ? "javascriptreact"
        : filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs") ? "javascript"
        : "typescript")
      : config.language;

    if (!this.openFiles.has(filePath)) {
      this.sendNotification(connection, "textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: content,
        },
      });
      this.openFiles.add(filePath);
    } else {
      this.sendNotification(connection, "textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });
    }

    // Also send didSave to trigger full diagnostics.
    this.sendNotification(connection, "textDocument/didSave", {
      textDocument: { uri },
      text: content,
    });
  }

  /**
   * Get diagnostics for a file. Returns null if no LSP server handles it.
   * Waits briefly for diagnostics to arrive after a change notification.
   */
  async getDiagnostics(filePath: string, waitMs = 2000): Promise<Diagnostic[] | null> {
    const config = this.serverForFile(filePath);
    if (!config) return null;

    const connection = this.connections.get(config.language);
    if (!connection?.initialized) return null;

    const relative = path.relative(this.root, path.resolve(this.root, filePath));

    // Wait for diagnostics to arrive (LSP publishes them asynchronously).
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const diags = connection.diagnostics.get(relative);
      if (diags !== undefined) return diags;
      await new Promise((r) => setTimeout(r, 100));
    }

    return connection.diagnostics.get(relative) ?? [];
  }

  /**
   * Get diagnostics for a file after an edit, formatted as a compact string
   * suitable for appending to a tool result. Returns empty string if no
   * diagnostics or no server available.
   */
  async getDiagnosticsAfterEdit(filePath: string, content: string): Promise<string> {
    await this.notifyFileChanged(filePath, content);
    const diagnostics = await this.getDiagnostics(filePath);

    if (!diagnostics || diagnostics.length === 0) return "";

    const errors = diagnostics.filter((d) => d.severity === "error");
    const warnings = diagnostics.filter((d) => d.severity === "warning");

    if (errors.length === 0 && warnings.length === 0) return "";

    const lines: string[] = [];
    if (errors.length > 0) {
      lines.push(`\n[LSP] ${errors.length} error(s) detected:`);
      for (const e of errors.slice(0, 10)) {
        lines.push(`  ${e.file}:${e.line}:${e.column}: error: ${e.message}`);
      }
      if (errors.length > 10) {
        lines.push(`  ... and ${errors.length - 10} more errors`);
      }
    }
    if (warnings.length > 0 && warnings.length <= 5) {
      lines.push(`[LSP] ${warnings.length} warning(s):`);
      for (const w of warnings.slice(0, 5)) {
        lines.push(`  ${w.file}:${w.line}:${w.column}: warning: ${w.message}`);
      }
    } else if (warnings.length > 5) {
      lines.push(`[LSP] ${warnings.length} warnings (showing first 5):`);
      for (const w of warnings.slice(0, 5)) {
        lines.push(`  ${w.file}:${w.line}:${w.column}: warning: ${w.message}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get all diagnostics across all files for all active servers.
   */
  getAllDiagnostics(): Diagnostic[] {
    const all: Diagnostic[] = [];
    for (const connection of this.connections.values()) {
      for (const diags of connection.diagnostics.values()) {
        all.push(...diags);
      }
    }
    return all;
  }

  /**
   * Shut down all LSP servers.
   */
  async shutdown(): Promise<void> {
    for (const [language, connection] of this.connections) {
      try {
        await this.sendRequest(connection, "shutdown", null);
        this.sendNotification(connection, "exit", null);
      } catch {
        // Server may already be dead.
      }
      try {
        connection.process.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      this.connections.delete(language);
    }
    this.openFiles.clear();
  }
}
