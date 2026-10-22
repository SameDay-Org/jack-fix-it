import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import {
  fromThisSite,
  LOGIN_PATH,
  mayChangeSession,
  PANEL_PATH,
  refreshStaffSession,
} from "@/lib/session";

// Reached by a redirect from requireStaff() when the access token is missing or refused. It
// refreshes once and rotates both cookies (only a route handler may write them), then returns
// to the panel, or to the login when the session cannot be renewed. A request from another
// site arrives without the Strict cookies: it only goes to the panel and writes no cookie, so
// it can neither refresh nor delete the browser's session.
export async function GET(request: NextRequest): Promise<never> {
  if (!fromThisSite(request)) redirect(PANEL_PATH);
  if (!mayChangeSession(request)) redirect(LOGIN_PATH); // no session cookie: nothing to do
  redirect(await refreshStaffSession());
}
