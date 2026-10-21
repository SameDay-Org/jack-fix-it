import { Stack } from "expo-router";

// Welcome is where the group lands, including when the signed-in group redirects here.
export const unstable_settings = { anchor: "welcome" };

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
