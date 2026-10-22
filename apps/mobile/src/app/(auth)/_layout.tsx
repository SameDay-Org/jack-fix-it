import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { Platform } from "react-native";

import { risenFromWelcome } from "@/features/auth";

// Welcome is where the group lands, including when the signed-in group redirects here.
export const unstable_settings = { anchor: "welcome" };

type ScreenOptions = NonNullable<ComponentProps<typeof Stack.Screen>["options"]>;

// From Welcome, the panel rise is the transition (see `risenFromWelcome`); reached any other way
// (a deep link, sign-up's "log in instead"), these screens keep the platform's default push.
const afterPanelRise: ScreenOptions = ({ route }) => risenFromWelcome(route.params, Platform.OS);

// A screen prefetched for the panel (`from: "welcome"`) is reused only by a navigation from
// Welcome: the router matches preloaded routes by name and id, and a replace keeps the preloaded
// params, so without an id "log in instead" would take over the panel's login.
const byOrigin = ({ params }: { params?: object }) =>
  (params as { from?: string } | undefined)?.from;

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="role" options={afterPanelRise} getId={byOrigin} />
      <Stack.Screen name="login" options={afterPanelRise} getId={byOrigin} />
    </Stack>
  );
}
