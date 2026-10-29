import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The quote list is always under the accept sheet and the pro's profile, even when a link opens
// one of them directly: back from the profile goes to the comparison.
export const unstable_settings = { anchor: "index" };

export default function RequestLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="quotes/[quoteId]/pro" />
      <Stack.Screen name="accept" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
