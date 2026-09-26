/**
 * POST /api/inline-edit { repoKey, path, startLine, endLine, instruction } (SSE)
 *
 *   { type: "delta", text }          streamed model output
 *   { type: "done", replacement }    cleaned replacement for lines start..end
 *   { type: "error", message }
 *
 * Lines are 1-based and inclusive. Nothing is written — the editor shows the
 * replacement as a diff and applies it on accept.
 */

import { encodeSse, sseHeaders } from "@/lib/sse";
import { openWorkspace, readFile } from "@/lib/workspace";
import { inlineEdit } from "@/lib/workspace/assist";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const filePath = typeof body.path === "string" ? body.path : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const startLine = Number(body.startLine);
  const endLine = Number(body.endLine);
  if (!repoKey || !filePath || !instruction) {
    return Response.json({ error: "repoKey, path and instruction are required" }, { status: 400 });
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return Response.json({ error: "startLine/endLine must be 1-based and ordered" }, { status: 400 });
  }
  if (instruction.length > 4000) {
    return Response.json({ error: "Instruction too long" }, { status: 400 });
  }

  let source: string | null;
  try {
    source = await readFile(await openWorkspace(repoKey), filePath);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Cannot read file" },
      { status: 400 },
    );
  }
  if (source === null) return Response.json({ error: "File not found" }, { status: 404 });
  const lineCount = source.split("\n").length;
  if (endLine > lineCount) {
    return Response.json({ error: `File has ${lineCount} lines` }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (payload: unknown) => {
        try {
          controller.enqueue(encodeSse(payload));
        } catch {
          // Client went away.
        }
      };
      try {
        const replacement = await inlineEdit(
          { path: filePath, source: source!, startLine, endLine, instruction },
          (text) => push({ type: "delta", text }),
          { signal: request.signal },
        );
        push({ type: "done", replacement });
      } catch (error) {
        push({ type: "error", message: error instanceof Error ? error.message : "Inline edit failed" });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
