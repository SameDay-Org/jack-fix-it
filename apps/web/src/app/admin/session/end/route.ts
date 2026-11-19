import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { RETURN_PARAM, safeReturnPath, withReturn } from "@/lib/return-path";
import { endSession, LOGIN_PATH, mayChangeSession } from "@/lib/session";

// Reached by a redirect from requireStaff() when the session is not a valid staff session: it
// revokes and clears it, then shows the login. A request from another site, or one that carries
// no session cookie (a link followed in a browser without Fetch Metadata), only lands on the
// login: it cannot sign a staff member out. The page that was asked for goes along to the login
// (`?next=`, #464), validated again here: anything but a panel path is dropped.
export async function GET(request: NextRequest): Promise<never> {
  const back = safeReturnPath(request.nextUrl.searchParams.get(RETURN_PARAM));
  if (mayChangeSession(request)) await endSession();
  redirect(withReturn(LOGIN_PATH, back));
}
