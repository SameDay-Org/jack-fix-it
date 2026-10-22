import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";

import { Button, Input, Screen } from "@/components/ui";
import { BackButton } from "@/features/auth/components/BackButton";

import { CODE_LENGTH, phoneConfig } from "./config";
import { leavePhoneFlow, withdrawPhoneStepOffer } from "./phoneFlow";
import { usePhoneEntry } from "./usePhoneEntry";

/**
 * The phone step: a US number behind the fixed calling code, then "Send code". Reached from home
 * it has a Back button; right after a sign-up (`from: "sign-up"`) it offers "Skip for now"
 * instead, since verification is not required yet.
 */
export function PhoneEntryScreen() {
  const { t } = useTranslation();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const afterSignUp = from === "sign-up";
  const entry = usePhoneEntry(() => router.push("/verify-phone/code"));

  // Shown once: a later sign-in lands on home again.
  useEffect(() => {
    if (afterSignUp) withdrawPhoneStepOffer();
  }, [afterSignUp]);

  return (
    <Screen bar="light" testID="phone-entry-screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <ScrollView
          contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {afterSignUp ? <View className="h-12" /> : <BackButton />}
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-title-1 text-navy-900">
              {t("phone.title")}
            </Text>
            <Text className="text-callout text-gray-500">
              {t("phone.subtitle", { length: CODE_LENGTH })}
            </Text>
          </View>
          <Input
            label={t("phone.numberLabel")}
            prefix={phoneConfig.countryCode}
            value={entry.text}
            onChangeText={entry.setText}
            error={entry.error ?? undefined}
            disabled={entry.sending}
            keyboardType="phone-pad"
            inputMode="tel"
            textContentType="telephoneNumber"
            autoComplete="tel"
            importantForAutofill="yes"
            autoFocus
            returnKeyType="send"
            submitBehavior="blurAndSubmit"
            onSubmitEditing={() => void entry.submit()}
            testID="phone-number"
          />
          <View className="flex-1" />
          <View className="gap-3">
            <Button
              label={t("phone.send")}
              size="lg"
              loading={entry.sending}
              onPress={() => void entry.submit()}
              testID="phone-send"
            />
            {afterSignUp ? (
              <Button
                label={t("phone.skip")}
                variant="ghost"
                disabled={entry.sending}
                onPress={leavePhoneFlow}
                testID="phone-skip"
              />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
