import { Stack } from "expo-router";
import type { ComponentProps } from "react";

// Welcome is where the group lands, including when the signed-in group redirects here.
export const unstable_settings = { anchor: "welcome" };

type ScreenOptions = NonNullable<ComponentProps<typeof Stack.Screen>["options"]>;

// From Welcome, the panel rise is the transition: the route only fades in where the panel ended,
// and fades out on the way back so the iOS edge swipe keeps working. Reached any other way (a deep
// link, sign-up's "log in instead"), these screens keep the platform's default push.
const risenFromWelcome: ScreenOptions = ({ route }) => ({
  animation:
    (route.params as { from?: string } | undefined)?.from === "welcome" ? "fade" : "default",
});

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="role" options={risenFromWelcome} />
      <Stack.Screen name="login" options={risenFromWelcome} />
    </Stack>
  );
}
