import { type NextRequest, NextResponse } from "next/server";

import { PATH_HEADER } from "@/lib/return-path";

/**
 * Tells the panel's server components which page was asked for (`PATH_HEADER`): server
 * components do not see the request's URL, and the sign-in comes back to that page (#464).
 * The header is always overwritten here, so a client cannot choose it. Nothing else changes:
 * no redirect, no response header. The panel only: the public pages stay static.
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
