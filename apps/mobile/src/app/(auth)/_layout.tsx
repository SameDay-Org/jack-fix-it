import { Stack } from "expo-router";
import type { ComponentProps } from "react";
import { Platform } from "react-native";

import { risenFromWelcome } from "@/features/auth";

// Welcome is where the group lands, including when the signed-in group redirects here.
export const unstable_settings = { anchor: "welcome" };

type ScreenOptions = NonNullable<ComponentProps<typeof Stack.Screen>["options"]>;

// From Welcome, the panel rise is the transition (see `risenFromWelcome`); reached any other way
// (a deep link, sign-up's "log in instead"), these screens keep the platform's default push.
const afterPanelRise: ScreenOptions = ({ route }) => ({
  animation: risenFromWelcome(route.params, Platform.OS),
});

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="role" options={afterPanelRise} />
      <Stack.Screen name="login" options={afterPanelRise} />
    </Stack>
  );
}
