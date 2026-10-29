import { Stack } from "expo-router";
import { View } from "react-native";

import { useSession } from "@/api";
import { PanelHandoffProvider } from "@/features/auth";
// The options alone: the request barrel registers its draft with the session at import.
import { requestFlowOptions } from "@/features/request/rise";

// The tabs are always the first screen of the group, so a flow pushed over them (the phone steps,
// even when a sign-up lands straight on them; a request opened from a deep link) ends by popping
// back to a tab: the one it left, or Home after a cold start.
export const unstable_settings = { anchor: "(tabs)" };

/**
 * The signed-in group: the tab shell (D18) and the flows pushed over it. Its screens exist only
 * while a session is signed in, enforced here for all of them rather than screen by screen:
 * without one the layout renders the session shell in place of its stack, so from the first
 * commit of a sign-out, of a refresh the server rejected or of an expired session, no private
 * screen, value or control is in the tree. The gate's switch to
 * `(auth)` is the next commit, before that one is drawn (see `GroupStack`); the shell is what this
 * group holds in between, and under the stack's push while Welcome arrives.
 *
 * A category card on Home opens the request flow with the panel rise (the categories panel rises
 * into the flow's first step); the hand-off lives as long as the group, like `(auth)`'s.
 */
export default function AppLayout() {
  const { status } = useSession();
  if (status !== "signedIn") return <SessionShell />;
  return (
    <PanelHandoffProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="request/(flow)" options={requestFlowOptions} />
      </Stack>
    </PanelHandoffProvider>
  );
}

/** The brand surface alone: no user data, no controls, and nothing for accessibility to reach. */
function SessionShell() {
  return (
    <View
      className="flex-1 bg-navy-900"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="session-shell"
    />
  );
}
