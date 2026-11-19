import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { RETURN_PARAM, safeReturnPath, withReturn } from "@/lib/return-path";
import {
  fromThisSite,
  LOGIN_PATH,
  mayChangeSession,
  PANEL_PATH,
  refreshStaffSession,
} from "@/lib/session";

// Reached by a redirect from requireStaff() when the access token is missing or refused. It
// refreshes once and rotates both cookies (only a route handler may write them), then returns
// to the page that was asked for (`?next=`, #464, validated again: else the panel), or to the
// login when the session cannot be renewed, still carrying that page. A request from another
// site arrives without the Strict cookies: it only goes to the panel and writes no cookie, so
// it can neither refresh nor delete the browser's session.
export async function GET(request: NextRequest): Promise<never> {
  if (!fromThisSite(request)) redirect(PANEL_PATH);
  const back = safeReturnPath(request.nextUrl.searchParams.get(RETURN_PARAM));
  if (!mayChangeSession(request)) redirect(withReturn(LOGIN_PATH, back)); // nothing to refresh
  const next = await refreshStaffSession();
  redirect(next === PANEL_PATH ? (back ?? PANEL_PATH) : withReturn(next, back));
}
