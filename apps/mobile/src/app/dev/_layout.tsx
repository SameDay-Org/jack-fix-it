// Dev-only routes: the component gallery and the sheet it opens. Unreachable outside __DEV__.
import { Redirect, Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";

export default function DevLayout() {
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="components" />
      <Stack.Screen name="sheet" options={sheetOptions([0.6, 0.95])} />
    </Stack>
  );
}
