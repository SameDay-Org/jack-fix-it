import { Stack } from "expo-router";

// Home is always the first screen of the group, so a flow pushed over it (the phone steps, even
// when a sign-up lands straight on them) ends by popping back to it.
export const unstable_settings = { anchor: "index" };

export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
