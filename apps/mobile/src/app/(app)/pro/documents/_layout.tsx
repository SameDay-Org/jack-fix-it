import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The list is always under a document and its sheet, even when a link opens one directly.
export const unstable_settings = { anchor: "index" };

/** The pro's verification documents: the list, one type, and "Camera or library" as a sheet. */
export default function ProDocumentsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="media-source" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
