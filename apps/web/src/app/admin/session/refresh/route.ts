import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { RETURN_PARAM, safeReturnPath, withReturn } from "@/lib/return-path";
import {
  busyPath,
  fromThisSite,
  LOGIN_PATH,
  mayChangeSession,
  PANEL_PATH,
  RETRIED_PARAM,
  refreshStaffSession,
} from "@/lib/session";

// Reached by a redirect from requireStaff() when the access token is missing or refused. It
// refreshes once and rotates both cookies (only a route handler may write them), then returns
// to the page that was asked for (`?next=`, #464, validated again: else the panel), or to the
// login when the session cannot be renewed, still carrying that page. When the API is busy
// (429, 503, no answer) the session stays and the busy page shows, with the API's wait when it
// is short enough for the page's one retry; that retry comes back here marked `retried`, and
// is never given another (#530). A request from another site arrives without the Strict
// cookies: it only goes to the panel and writes no cookie, so it can neither refresh nor
// delete the browser's session.
export async function GET(request: NextRequest): Promise<never> {
  if (!fromThisSite(request)) redirect(PANEL_PATH);
  const back = safeReturnPath(request.nextUrl.searchParams.get(RETURN_PARAM));
  if (!mayChangeSession(request)) redirect(withReturn(LOGIN_PATH, back)); // nothing to refresh
  const next = await refreshStaffSession();
  if (typeof next !== "string") {
    const retried = request.nextUrl.searchParams.has(RETRIED_PARAM);
    redirect(busyPath(back, retried ? null : next.retryAfterSeconds));
  }
  redirect(next === PANEL_PATH ? (back ?? PANEL_PATH) : withReturn(next, back));
}
