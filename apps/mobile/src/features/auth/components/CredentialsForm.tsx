import { useLocalSearchParams } from "expo-router";
import { useRef, type ComponentRef } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
  type TextInputProps,
} from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";

import { Button, Input, PasswordInput, Screen, type InputHandle } from "@/components/ui";

import type { CredentialsForm as CredentialsFormState } from "../useCredentialsForm";
import { useContentTransition } from "../useContentTransition";
import { BackButton } from "./BackButton";
import { FormError } from "./FormError";

type CredentialsFormProps = {
  title: string;
  subtitle?: string;
  form: CredentialsFormState;
  submitLabel: string;
  /** Autofill intent of the password field: a new password on sign-up, the current one on login. */
  passwordAutofill: Pick<TextInputProps, "textContentType" | "autoComplete">;
  passwordHint?: string;
  onLoginInstead?: () => void;
  testID: string;
};

/**
 * Email and password with one primary action. Return moves from email to password, then submits;
 * the keyboard never covers the focused field (iOS pads, Android resizes the window). Reached
 * from Welcome's panel (login), the content enters once the panel has become this page.
 */
export function CredentialsForm({
  title,
  subtitle,
  form,
  submitLabel,
  passwordAutofill,
  passwordHint,
  onLoginInstead,
  testID,
}: CredentialsFormProps) {
  const { t } = useTranslation();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const passwordRef = useRef<InputHandle>(null);
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  const fromWelcome = from === "welcome";
  const { style, enter, exit, busy } = useContentTransition({
    animate: fromWelcome,
    reduceMotion: useReducedMotion(),
    titleRef,
  });
  const focusPassword = () => passwordRef.current?.focus();
  const submit = () => void form.submitForm();
  const highlighted = (field: "email" | "password") =>
    form.failure?.highlight.includes(field) ?? false;

  return (
    <Screen bar="light" testID={testID}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <Animated.View
          className="flex-1"
          style={style}
          onLayout={enter}
          needsOffscreenAlphaCompositing
          pointerEvents={busy ? "none" : "auto"}
          testID={`${testID}-content`}
        >
          <ScrollView
            contentContainerClassName="flex-grow gap-6 px-4 pb-4 pt-2"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <BackButton beforeBack={fromWelcome ? exit : undefined} />
            <View className="gap-2">
              <Text
                ref={titleRef}
                accessibilityRole="header"
                className="text-title-1 text-navy-900"
              >
                {title}
              </Text>
              {subtitle ? <Text className="text-callout text-gray-500">{subtitle}</Text> : null}
            </View>
            <FormError
              failure={form.failure}
              onLoginInstead={onLoginInstead}
              testID={`${testID}-error`}
            />
            <View className="gap-4">
              <Input
                label={t("fields.email")}
                value={form.email}
                onChangeText={form.setEmail}
                error={form.fieldErrors.email}
                invalid={highlighted("email")}
                disabled={form.submitting}
                keyboardType="email-address"
                inputMode="email"
                autoComplete="email"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                importantForAutofill="yes"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={focusPassword}
                testID={`${testID}-email`}
              />
              <PasswordInput
                ref={passwordRef}
                label={t("fields.password")}
                value={form.password}
                onChangeText={form.setPassword}
                error={form.fieldErrors.password}
                invalid={highlighted("password")}
                hint={passwordHint}
                disabled={form.submitting}
                {...passwordAutofill}
                importantForAutofill="yes"
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
                onSubmitEditing={submit}
                testID={`${testID}-password`}
              />
            </View>
            <View className="flex-1" />
            <Button
              label={submitLabel}
              size="lg"
              loading={form.submitting}
              onPress={submit}
              testID={`${testID}-submit`}
            />
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
