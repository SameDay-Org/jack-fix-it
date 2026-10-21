import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { useSession } from "@/api";

import { OfflineScreen } from "./OfflineScreen";

/**
 * The one place that turns the session status into what the app shows. `restoring` keeps the
 * native splash the root layout holds; the first real screen hides it. A restore that could not
 * reach the server shows the offline screen instead of asking for a login the device may not
 * need. Signed in goes to `(app)`, everyone else to `(auth)`, deep links included: a protected
 * group redirects to the other group's entry.
 */
export function SessionGate() {
  const { status, restoreFailure } = useSession();
  const ready = status !== "restoring";

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  if (restoreFailure === "offline") return <OfflineScreen />;

  const signedIn = status === "signedIn";
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn} redirectTo="/(auth)/welcome">
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn} redirectTo="/">
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
