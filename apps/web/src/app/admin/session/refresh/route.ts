import { redirect } from "next/navigation";

import { refreshStaffSession } from "@/lib/session";

// Reached by a redirect from requireStaff() when the access token is missing or refused. It
// refreshes once and rotates both cookies (only a route handler may write them), then returns
// to the panel, or to the login when the session cannot be renewed. SameSite=Strict keeps the
// cookies off cross-site requests, so another site cannot drive a refresh.
export async function GET(): Promise<never> {
  redirect(await refreshStaffSession());
}
