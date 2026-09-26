/**
 * Server-side resolution of `@` attachments.
 *
 * The composer sends references for anything the server can read itself
 * (files, folders, symbols, the git diff, URLs) and inline content only for
 * what lives in the browser. This turns the list into one
 * `## Attached context` block that rides along with the user's prompt. A
 * reference that cannot be resolved becomes a one-line note rather than an
 * error: the user should learn the file was missing, not lose the run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ContextAttachment } from "@/lib/composer/types";
import { listFiles, readFile, type WorkspaceHandle } from "@/lib/workspace";

const run = promisify(execFile);

/** Per-attachment ceiling, in characters. */
const ITEM_CAP = 40_000;
/** Whole-block ceiling, in characters (~30k tokens). */
const TOTAL_CAP = 120_000;

function clip(text: string, cap = ITEM_CAP): string {
  return text.length > cap ? `${text.slice(0, cap)}\n… [truncated]` : text;
}

function fence(text: string, lang = ""): string {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function lines(source: string, start?: number, end?: number): string {
  if (!start) return source;
  const all = source.split("\n");
  return all.slice(Math.max(0, start - 1), end ?? start + 80).join("\n");
}

async function gitDiff(handle: WorkspaceHandle): Promise<string> {
  if (!handle.rootPath) return "(This workspace has no folder on disk, so there is no git diff.)";
  try {
    const { stdout } = await run("git", ["diff", "HEAD", "--no-color"], {
      cwd: handle.rootPath,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    return stdout.trim() ? fence(clip(stdout), "diff") : "(No uncommitted changes.)";
  } catch (error) {
    return `(git diff failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
}

async function fetchUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (!response.ok) return `(Fetching failed: HTTP ${response.status}.)`;
    const type = response.headers.get("content-type") ?? "";
    if (!/text|json|xml|javascript/.test(type)) return `(Not a text resource: ${type || "unknown type"}.)`;
    let body = await response.text();
    if (type.includes("html")) {
      body = body
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n");
    }
    return clip(body.trim(), 20_000);
  } catch (error) {
    return `(Fetching failed: ${error instanceof Error ? error.message : String(error)}.)`;
  }
}

async function resolveOne(
  handle: WorkspaceHandle,
  attachment: ContextAttachment,
): Promise<string> {
  switch (attachment.kind) {
    case "file": {
      const source = await readFile(handle, attachment.path).catch(() => null);
      return source === null
        ? `### ${attachment.path}\n\n(File not found.)`
        : `### ${attachment.path}\n\n${fence(clip(source))}`;
    }
    case "folder": {
      const prefix = `${attachment.path.replace(/\/+$/, "")}/`;
      const files = (await listFiles(handle).catch(() => []))
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => f.path)
        .sort();
      return `### ${prefix} (folder)\n\n${
        files.length ? clip(files.join("\n"), 8_000) : "(Empty or not found.)"
      }`;
    }
    case "symbol": {
      const source = await readFile(handle, attachment.path).catch(() => null);
      if (source === null) return `### ${attachment.name} (${attachment.path})\n\n(File not found.)`;
      const range = attachment.startLine
        ? `:${attachment.startLine}-${attachment.endLine ?? attachment.startLine + 80}`
        : "";
      return `### ${attachment.name} (${attachment.path}${range})\n\n${fence(
        clip(lines(source, attachment.startLine, attachment.endLine)),
      )}`;
    }
    case "selection":
      return `### Selection ${attachment.path}:${attachment.startLine}-${attachment.endLine}\n\n${fence(clip(attachment.content))}`;
    case "terminal":
      return `### Terminal: ${attachment.label}\n\n${fence(clip(attachment.content))}`;
    case "problems":
      return `### Problems\n\n${fence(clip(attachment.content))}`;
    case "git_diff":
      return `### Git diff (working tree vs HEAD)\n\n${await gitDiff(handle)}`;
    case "url":
      return `### ${attachment.url}\n\n${await fetchUrl(attachment.url)}`;
  }
}

/** Render attachments as one block, or "" when there are none. */
export async function resolveAttachments(
  handle: WorkspaceHandle,
  attachments: ContextAttachment[],
): Promise<string> {
  if (attachments.length === 0) return "";
  const sections = await Promise.all(attachments.map((a) => resolveOne(handle, a)));
  let used = 0;
  const kept: string[] = [];
  for (const section of sections) {
    if (used + section.length > TOTAL_CAP) {
      kept.push("(Further attachments omitted: the attached context hit its size cap.)");
      break;
    }
    used += section.length;
    kept.push(section);
  }
  return `## Attached context\n\nThe user attached these to the request.\n\n${kept.join("\n\n")}`;
}
