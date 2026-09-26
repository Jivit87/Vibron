import { NextResponse, type NextRequest } from "next/server";

import { guardRequest } from "@/lib/workspace/request-guard";

/**
 * Every request must come from a loopback Host; API requests must also be
 * same-origin and, when mutating, JSON. See `lib/workspace/request-guard.ts`.
 */
export function middleware(request: NextRequest) {
  const rejection = guardRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
  });
  if (rejection) {
    return NextResponse.json({ error: rejection.error }, { status: rejection.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
