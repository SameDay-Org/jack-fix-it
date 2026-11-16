import { Redirect } from "expo-router";
import type { ReactNode } from "react";

import { useSession } from "@/api";

/**
 * The pro's own screens (`/pro/...`): anyone else signed in (a customer, staff) is sent home,
 * and nothing under it is built for them, so no pro query is asked in their name.
 */
export function ProOnly({ children }: { children: ReactNode }) {
  const role = useSession().user?.role;
  return role === "pro" ? children : <Redirect href="/" />;
}
