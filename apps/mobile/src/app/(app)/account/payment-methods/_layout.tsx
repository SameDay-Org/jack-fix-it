import { Stack } from "expo-router";

import { sheetOptions } from "@/components/ui";
import { CustomerOnly } from "@/features/payment-methods";

// The wallet is always under an opened card, even when a link opens one directly.
export const unstable_settings = { anchor: "index" };

/** Account > Payment methods (customers only): the wallet, and a card opened as a sheet. */
export default function PaymentMethodsLayout() {
  return (
    <CustomerOnly>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="[id]" options={sheetOptions("fitToContents")} />
      </Stack>
    </CustomerOnly>
  );
}
