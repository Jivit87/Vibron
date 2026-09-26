/**
 * Shapes shared by the composer (client) and the agent route (server).
 *
 * An attachment is *explicit* context the user pinned to a prompt with `@`.
 * Items that only the browser can see (the editor selection, terminal
 * output, Monaco problems) carry their content inline; items the server can
 * read itself (files, folders, symbols, the git diff, URLs) travel as
 * references and are resolved server-side, so a large file never has to
 * round-trip through the browser.
 */

export type ContextAttachment =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string }
  | {
      kind: "symbol";
      name: string;
      path: string;
      startLine?: number;
      endLine?: number;
    }
  | {
      kind: "selection";
      path: string;
      startLine: number;
      endLine: number;
      content: string;
    }
  | { kind: "terminal"; label: string; content: string }
  | { kind: "problems"; content: string }
  | { kind: "git_diff" }
  | { kind: "url"; url: string };

export type ContextAttachmentKind = ContextAttachment["kind"];

export const IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** A pasted or dropped image, as base64 without the `data:` prefix. */
export interface ImageAttachment {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

/** Explicit routing hint from a slash command. */
export type IntentHint = "ask" | "build";

/** Limits enforced on both sides of the wire. */
export const MAX_ATTACHMENTS = 20;
export const MAX_IMAGES = 6;
/** ~5 MB of raw image, expressed as base64 length. */
export const MAX_IMAGE_BASE64 = 7_000_000;
/** Per-item cap for client-captured content (selection, terminal, …). */
export const MAX_INLINE_CONTENT = 40_000;

/** Short human label for a chip. */
export function attachmentLabel(attachment: ContextAttachment): string {
  switch (attachment.kind) {
    case "file":
    case "folder":
      return basename(attachment.path) || attachment.path;
    case "symbol":
      return attachment.name;
    case "selection":
      return `${basename(attachment.path)}:${attachment.startLine}-${attachment.endLine}`;
    case "terminal":
      return attachment.label || "Terminal";
    case "problems":
      return "Problems";
    case "git_diff":
      return "Git diff";
    case "url":
      return attachment.url.replace(/^https?:\/\//, "").slice(0, 40);
  }
}

/** Stable identity, used to dedupe chips. */
export function attachmentKey(attachment: ContextAttachment): string {
  switch (attachment.kind) {
    case "file":
    case "folder":
      return `${attachment.kind}:${attachment.path}`;
    case "symbol":
      return `symbol:${attachment.path}#${attachment.name}`;
    case "selection":
      return `selection:${attachment.path}:${attachment.startLine}-${attachment.endLine}`;
    case "terminal":
      return `terminal:${attachment.label}`;
    case "problems":
      return "problems";
    case "git_diff":
      return "git_diff";
    case "url":
      return `url:${attachment.url}`;
  }
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Validate an untrusted attachment list from a request body. Anything
 * malformed is dropped rather than failing the whole run.
 */
export function sanitizeAttachments(raw: unknown): ContextAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextAttachment[] = [];
  const str = (v: unknown, max = 2000) =>
    typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  const inline = (v: unknown) =>
    typeof v === "string" ? v.slice(0, MAX_INLINE_CONTENT) : null;

  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    switch (a.kind) {
      case "file":
      case "folder": {
        const path = str(a.path);
        if (path) out.push({ kind: a.kind, path });
        break;
      }
      case "symbol": {
        const name = str(a.name, 300);
        const path = str(a.path);
        if (name && path) {
          out.push({
            kind: "symbol",
            name,
            path,
            startLine: num(a.startLine),
            endLine: num(a.endLine),
          });
        }
        break;
      }
      case "selection": {
        const path = str(a.path);
        const content = inline(a.content);
        const startLine = num(a.startLine);
        const endLine = num(a.endLine);
        if (path && content !== null && startLine !== undefined && endLine !== undefined) {
          out.push({ kind: "selection", path, startLine, endLine, content });
        }
        break;
      }
      case "terminal": {
        const content = inline(a.content);
        if (content !== null) {
          out.push({
            kind: "terminal",
            label: str(a.label, 300) ?? "Terminal",
            content,
          });
        }
        break;
      }
      case "problems": {
        const content = inline(a.content);
        if (content !== null) out.push({ kind: "problems", content });
        break;
      }
      case "git_diff":
        out.push({ kind: "git_diff" });
        break;
      case "url": {
        const url = str(a.url);
        if (url && /^https?:\/\//i.test(url)) out.push({ kind: "url", url });
        break;
      }
    }
  }
  return out;
}

export function sanitizeImages(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageAttachment[] = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== "object") continue;
    const img = item as Record<string, unknown>;
    if (
      typeof img.mediaType === "string" &&
      (IMAGE_MEDIA_TYPES as readonly string[]).includes(img.mediaType) &&
      typeof img.data === "string" &&
      img.data.length > 0 &&
      img.data.length <= MAX_IMAGE_BASE64 &&
      /^[A-Za-z0-9+/=]+$/.test(img.data.slice(0, 200))
    ) {
      out.push({
        mediaType: img.mediaType as ImageMediaType,
        data: img.data,
        name: typeof img.name === "string" ? img.name.slice(0, 200) : undefined,
      });
    }
  }
  return out;
}
