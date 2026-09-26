/** Minimal Server-Sent-Events helpers shared by the streaming API routes. */

const encoder = new TextEncoder();

export function encodeSse(data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return encoder.encode(`data: ${payload}\n\n`);
}

export function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}
