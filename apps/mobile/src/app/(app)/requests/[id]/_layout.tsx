import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The quote list is always under the accept sheet, even when a link opens the sheet directly.
export const unstable_settings = { anchor: "index" };

export default function RequestLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="accept" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
