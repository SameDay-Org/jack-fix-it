import { Stack } from "expo-router";

import { ProOnly } from "@/features/pro-profile";

/** The pro's own screens: built for a pro only, anyone else is sent home (`ProOnly`). */
export default function ProLayout() {
  return (
    <ProOnly>
      <Stack screenOptions={{ headerShown: false }} />
    </ProOnly>
  );
}
