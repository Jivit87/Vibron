/**
 * `viberon hooks list|trust|revoke` — the CLI side of lib/hooks.
 *
 * Trust is the same record the desktop app uses (`~/.viberon/hooks-trust.json`),
 * so approving here also approves in the app and vice versa. Approval shows
 * every command first and asks for confirmation; `--yes` skips the prompt
 * (CI), and `--hash` pins the exact file version being approved.
 */

import path from "node:path";

import { describeHooks, type HooksOverview } from "@/lib/hooks/engine";
import { revokeWorkspaceHooks, trustWorkspaceHooks } from "@/lib/hooks/trust";

export interface HooksArgs {
  command: "hooks";
  action: "list" | "trust" | "revoke";
  repo: string;
  yes: boolean;
  hash?: string;
  json: boolean;
}

export interface HooksIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Ask a yes/no question; absent when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
}

const TRUST_LABEL = {
  trusted: "trusted",
  untrusted: "NOT TRUSTED (these hooks do not run)",
  changed: "CHANGED since approval (these hooks do not run)",
  none: "no hooks file",
} as const;

function render(overview: HooksOverview): string {
  const lines: string[] = [];
  const ws = overview.workspace;
  if (ws) {
    lines.push(`Workspace  ${ws.path}  ${TRUST_LABEL[ws.trust]}${ws.hash ? `  sha256 ${ws.hash.slice(0, 16)}` : ""}`);
    for (const h of ws.hooks) {
      lines.push(`  ${h.event}${h.matcher ? `(${h.matcher})` : ""}  ${h.command}  [timeout ${Math.round(h.timeoutMs / 1000)}s]`);
    }
    for (const e of ws.errors) lines.push(`  error: ${e}`);
  }
  const g = overview.global;
  lines.push(`User       ${g?.path ?? "(no user config directory)"}${g?.exists ? "" : "  (none)"}`);
  for (const h of g?.hooks ?? []) {
    lines.push(`  ${h.event}${h.matcher ? `(${h.matcher})` : ""}  ${h.command}  [timeout ${Math.round(h.timeoutMs / 1000)}s]`);
  }
  for (const e of g?.errors ?? []) lines.push(`  error: ${e}`);
  lines.push(`Active: ${overview.active.length} command hook(s) will run.`);
  return `${lines.join("\n")}\n`;
}

export async function hooksCommand(args: HooksArgs, io: HooksIo): Promise<number> {
  const root = path.resolve(args.repo);
  const overview = await describeHooks(root);

  if (args.action === "list") {
    io.out(args.json ? `${JSON.stringify(overview, null, 2)}\n` : render(overview));
    return 0;
  }

  if (args.action === "revoke") {
    const removed = await revokeWorkspaceHooks(root);
    io.out(removed ? `Revoked hook approval for ${root}.\n` : `No approval recorded for ${root}.\n`);
    return 0;
  }

  const ws = overview.workspace;
  if (!ws?.exists || !ws.hash) {
    io.err(`No ${path.join(root, ".viberon", "hooks.json")} to trust.\n`);
    return 2;
  }
  if (!ws.hooks.length) {
    io.err(`The hooks file defines no runnable hooks${ws.errors.length ? `: ${ws.errors.join("; ")}` : "."}\n`);
    return 2;
  }
  if (args.hash && args.hash !== ws.hash) {
    io.err(`The hooks file does not match --hash (on disk: ${ws.hash}). Review it again.\n`);
    return 2;
  }
  io.out(render(overview));
  if (ws.trust === "trusted") {
    io.out("Already trusted.\n");
    return 0;
  }
  if (!args.yes) {
    if (!io.confirm) {
      io.err("Refusing to approve without confirmation. Review the commands above and re-run with --yes.\n");
      return 2;
    }
    const ok = await io.confirm(`Allow these ${ws.hooks.length} command(s) to run on every agent run in ${root}? [y/N] `);
    if (!ok) {
      io.err("Not approved.\n");
      return 1;
    }
  }
  await trustWorkspaceHooks(root, ws.hash);
  io.out(`Approved sha256 ${ws.hash}. Any change to the file will need a new approval.\n`);
  return 0;
}
