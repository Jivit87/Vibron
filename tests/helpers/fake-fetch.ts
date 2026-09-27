/**
 * A recording fetch for REST adapter tests: routes are matched by method and
 * exact URL (or a predicate), and every request is kept with its parsed
 * headers and body so tests can assert exactly what went over the wire.
 */

import { vi } from "vitest";

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | (() => Response) | ((req: Recorded) => Response);
type Matcher = string | ((req: Recorded) => boolean);

export function fakeFetch(routes: [method: string, match: Matcher, reply: Reply][]) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body,
    };
    calls.push(req);
    for (const [method, match, reply] of routes) {
      if (method !== req.method) continue;
      if (typeof match === "string" ? match !== req.url : !match(req)) continue;
      return typeof reply === "function" ? (reply as (r: Recorded) => Response)(req) : reply.clone();
    }
    return Response.json({ message: `unexpected ${req.method} ${req.url}` }, { status: 404 });
  });
  return { calls, fetchImpl: impl as unknown as typeof fetch };
}

export const json = (value: unknown, status = 200) => Response.json(value, { status });
