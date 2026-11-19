import { type NextRequest, NextResponse } from "next/server";

import { PATH_HEADER } from "@/lib/return-path";

/**
 * Tells the server components which page was asked for (`PATH_HEADER`): server components do
 * not see the request's URL. The panel's sign-in uses it to come back to that page (#464)
 * and the 404 page to answer in the page's language (#462). The header is always overwritten
 * here, so a client cannot choose it. Nothing else changes: no redirect, no response header.
 */
export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not Next's files, not the API routes, not files with an extension.
  matcher: ["/((?!_next/|api/|.*\\.[a-zA-Z0-9]+$).*)"],
};
