import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";

import { useSession } from "@/api";
import { LaunchHero } from "@/features/launch";
import { tokens } from "@/theme";

import { OfflineScreen } from "./OfflineScreen";

/**
 * The one place that turns the session status into what the app shows. While the session is
 * `restoring` it shows the static launch frame, the same navy hero the intro draws over it, so a
 * slow restore never shows a blank. A restore that could not reach the server shows the offline
 * screen instead of asking for a login the device may not need. Signed in goes to `(app)`,
 * everyone else to `(auth)`, deep links included: a protected group redirects to the other
 * group's entry.
 */
export function SessionGate() {
  const { t } = useTranslation();
  const { status, restoreFailure } = useSession();

  if (status === "restoring") {
    return (
      <LaunchHero
        testID="restoring-hero"
        word={
          <Text className="text-display text-green-500">
            {t("launch.words", { returnObjects: true })[0]}
          </Text>
        }
      />
    );
  }
  if (restoreFailure === "offline") return <OfflineScreen />;

  const signedIn = status === "signedIn";
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // The frame under a group while its first screen mounts: navy, like the splash and the
        // intro over it, so a quick handoff (Reduce Motion, a fast restore) never shows white.
        contentStyle: { backgroundColor: tokens.colors["navy-900"] },
      }}
    >
      <Stack.Protected guard={signedIn} redirectTo="/(auth)/welcome">
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn} redirectTo="/">
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
