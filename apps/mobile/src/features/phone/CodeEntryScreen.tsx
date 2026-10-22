import { Redirect, router } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, CodeInput, Screen } from "@/components/ui";

import { CODE_LENGTH, phoneConfig } from "./config";
import { forgetPendingNumber, leavePhoneFlow, usePendingNumber } from "./phoneFlow";
import { formatE164, toE164 } from "./phoneNumber";
import { useCodeEntry } from "./useCodeEntry";

/** The code step; with no number waiting for a code (a deep link) it goes to the phone step. */
export function CodeEntryScreen() {
  const digits = usePendingNumber();
  if (digits === null) return <Redirect href="/verify-phone" />;
  return <CodeEntry digits={digits} />;
}

/** "Change number" goes back to the phone step, which still holds the number to edit. */
const changeNumber = () => {
  if (router.canGoBack()) router.back();
  else router.replace("/verify-phone");
};

function CodeEntry({ digits }: { digits: string }) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const entry = useCodeEntry(digits, leavePhoneFlow);
  const { countryCode } = phoneConfig;
  // The number lives as long as this step does.
  useEffect(() => forgetPendingNumber, []);
  const busy = entry.verifying || entry.resending;

  return (
    <Screen bar="light" testID="code-entry-screen">
      <KeyboardAvoidingView
        // Padding on both platforms: the app draws edge to edge on Android, where the window
        // no longer resizes for the keyboard, so the actions would sit under it. It measures
        // itself from the content area, which `Screen` starts below the status bar: the offset
        // adds that back.
        behavior="padding"
        keyboardVerticalOffset={top}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View className="h-12" />
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {t("phone.codeTitle")}
            </Text>
            <Text className="text-callout text-gray-500" testID="code-sent-to">
              {t("phone.codeSubtitle", {
                phone: formatE164(toE164(countryCode, digits), countryCode),
              })}
            </Text>
          </View>
          <CodeInput
            label={t("phone.codeLabel")}
            value={entry.code}
            onChangeText={entry.setCode}
            length={CODE_LENGTH}
            error={entry.error ?? undefined}
            autoFocus
            testID="phone-code"
          />
          <View className="items-start gap-1">
            <Button
              label={
                entry.resendIn > 0
                  ? t("phone.resendIn", { seconds: entry.resendIn })
                  : t("phone.resend")
              }
              variant="ghost"
              disabled={entry.resendIn > 0 || busy}
              loading={entry.resending}
              onPress={() => void entry.resend()}
              className="-ml-5"
              testID="phone-resend"
            />
            <Button
              label={t("phone.changeNumber")}
              variant="ghost"
              disabled={busy}
              onPress={changeNumber}
              className="-ml-5"
              testID="phone-change-number"
            />
          </View>
          <View className="flex-1" />
          <Button
            label={t("phone.verify")}
            size="lg"
            loading={entry.verifying}
            disabled={entry.code.length < CODE_LENGTH || entry.resending}
            onPress={() => void entry.submit()}
            testID="phone-verify"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
