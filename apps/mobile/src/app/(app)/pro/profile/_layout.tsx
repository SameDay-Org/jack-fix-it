import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The form is always under its sheet, even when a link opens the sheet directly.
export const unstable_settings = { anchor: "index" };

/** The pro's profile: the form, and "Camera or library" as a sheet over it. */
export default function ProProfileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="media-source" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
