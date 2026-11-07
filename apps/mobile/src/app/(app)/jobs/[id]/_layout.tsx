import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

// The job is always under its sheets, even when a link opens one of them directly.
export const unstable_settings = { anchor: "index" };

export default function ProJobLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="on-the-way" options={sheetOptions("fitToContents")} />
      <Stack.Screen name="check-in" options={sheetOptions("fitToContents")} />
    </Stack>
  );
}
