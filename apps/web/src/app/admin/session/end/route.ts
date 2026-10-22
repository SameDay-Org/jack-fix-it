import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { endSession, LOGIN_PATH } from "@/lib/session";

// Reached by a redirect from requireStaff() when the session is not a valid staff session: it
// revokes and clears it, then shows the login. A link from another site (Sec-Fetch-Site:
// cross-site) only lands on the login, so it cannot sign a staff member out.
export async function GET(request: NextRequest): Promise<never> {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") await endSession();
  redirect(LOGIN_PATH);
}
