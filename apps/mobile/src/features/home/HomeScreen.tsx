import { useSession } from "@/api";
import { HomePlaceholderScreen } from "@/features/auth/HomePlaceholderScreen";
import { ProHomeScreen } from "@/features/pro-home";

import { CustomerHomeScreen } from "./CustomerHomeScreen";

/** The signed-in group's anchor (`/`): the customer home, the pro home, or the placeholder for staff. */
export function HomeScreen() {
  const { user } = useSession();
  if (user?.role === "customer") return <CustomerHomeScreen />;
  if (user?.role === "pro") return <ProHomeScreen />;
  return <HomePlaceholderScreen />;
}
