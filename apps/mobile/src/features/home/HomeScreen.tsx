import { useSession } from "@/api";
import { HomePlaceholderScreen } from "@/features/auth/HomePlaceholderScreen";

import { CustomerHomeScreen } from "./CustomerHomeScreen";

/** The signed-in group's anchor (`/`): the customer home, or the placeholder until the pro home (#38). */
export function HomeScreen() {
  const { user } = useSession();
  return user?.role === "customer" ? <CustomerHomeScreen /> : <HomePlaceholderScreen />;
}
