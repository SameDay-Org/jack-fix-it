import { Redirect } from "expo-router";
import type { ReactNode } from "react";

import { useSession } from "@/api";

/**
 * The wallet's screens (`/account/payment-methods/...`): only customers keep payment methods.
 * Anyone else signed in (a pro, staff) is sent back to Account, and nothing under it is built for
 * them, so no wallet is asked for in their name.
 */
export function CustomerOnly({ children }: { children: ReactNode }) {
  const role = useSession().user?.role;
  return role === "customer" ? children : <Redirect href="/account" />;
}
