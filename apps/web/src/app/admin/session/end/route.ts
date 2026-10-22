import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { endSession, LOGIN_PATH, mayChangeSession } from "@/lib/session";

// Reached by a redirect from requireStaff() when the session is not a valid staff session: it
// revokes and clears it, then shows the login. A request from another site, or one that carries
// no session cookie (a link followed in a browser without Fetch Metadata), only lands on the
// login: it cannot sign a staff member out.
export async function GET(request: NextRequest): Promise<never> {
  if (mayChangeSession(request)) await endSession();
  redirect(LOGIN_PATH);
}
