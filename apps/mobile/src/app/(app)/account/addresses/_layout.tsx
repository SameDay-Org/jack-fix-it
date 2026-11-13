import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The book is always under an address's menu and its form, even when a link opens one directly.
export const unstable_settings = { anchor: "index" };

/** Account > Addresses: the book, Add, an address's form, and its menu as a sheet. */
export default function AddressesLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]/actions" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
