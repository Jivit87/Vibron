/**
 * Pure helpers for the terminal SSE stream (docs/PLAN.md §3.3):
 *
 *   {type:"history", text, offset, status, detectedUrl}
 *   {type:"chunk", stream, text, offset}
 *   {type:"end", status, exitCode, detectedUrl}
 *
 * `offset` is taken to be the stream position *after* the event's text, so
 * a reconnect with `since=<offset>` resumes without duplicating output. When
 * resuming, `history` carries only what was missed and is appended; on a
 * fresh subscribe it is the whole buffer and replaces.
 */

import type { TerminalSessionView } from "@/store/viberon";

export type TerminalStreamEvent =
  | {
      type: "history";
      text?: string;
      offset?: number;
      status?: string;
      detectedUrl?: string | null;
    }
  | { type: "chunk"; stream?: string; text?: string; offset?: number }
  | { type: "end"; status?: string; exitCode?: number | null; detectedUrl?: string | null };

/**
 * Strip ANSI escape sequences: this is a log view, not an emulator. The
 * literal ESC prefix is load-bearing, or `[exited with code 0]` would go too.
 */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r(?!\n)/g, "\n");
}

const MAX_OUTPUT = 400_000;

export function applyTerminalEvent(
  session: TerminalSessionView,
  event: TerminalStreamEvent,
  resumed: boolean,
): TerminalSessionView {
  switch (event.type) {
    case "history": {
      const text = event.text ?? "";
      const output = resumed ? session.output + text : text;
      return {
        ...session,
        output: output.slice(-MAX_OUTPUT),
        offset: event.offset ?? (resumed ? (session.offset ?? 0) + text.length : text.length),
        detectedUrl: event.detectedUrl ?? session.detectedUrl,
      };
    }
    case "chunk": {
      const text = event.text ?? "";
      // A chunk at or before what we already have is a replay; drop it.
      if (event.offset !== undefined && session.offset !== undefined && event.offset <= session.offset) {
        return session;
      }
      return {
        ...session,
        output: (session.output + text).slice(-MAX_OUTPUT),
        offset: event.offset ?? (session.offset ?? 0) + text.length,
      };
    }
    case "end":
      return {
        ...session,
        status: event.status ?? "exited",
        exitCode: event.exitCode ?? null,
        detectedUrl: event.detectedUrl ?? session.detectedUrl,
      };
  }
}
