import { useLocalSearchParams } from "expo-router";
import { useRef, type ComponentRef } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View, type TextInputProps } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Screen } from "@/components/ui";

import type { CredentialsForm as CredentialsFormState } from "../useCredentialsForm";
import { useContentTransition } from "../useContentTransition";
import { BackButton } from "./BackButton";
import { CredentialsFields } from "./CredentialsFields";

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
 * the keyboard never covers the focused field or the action (padding on both platforms). Reached
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
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { top } = useSafeAreaInsets();
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  const fromWelcome = from === "welcome";
  const { rootStyle, contentStyle, enter, exit, statusBar, ownsStatusBar, busy } =
    useContentTransition({
      animate: fromWelcome,
      reduceMotion: useReducedMotion(),
      titleRef,
    });
  const submit = () => void form.submitForm();

  return (
    <Animated.View
      className="flex-1"
      style={rootStyle}
      needsOffscreenAlphaCompositing
      pointerEvents={busy ? "none" : "auto"}
      testID={`${testID}-root`}
    >
      <Screen bar="light" statusBar={statusBar} ownsStatusBar={ownsStatusBar} testID={testID}>
        <KeyboardAvoidingView
          // Padding on both platforms: the app draws edge to edge on Android, where the window
          // no longer resizes for the keyboard, so the action would sit under it. It measures
          // itself from the content area, which `Screen` starts below the status bar: the offset
          // adds that back.
          behavior="padding"
          keyboardVerticalOffset={top}
          className="flex-1"
          testID={`${testID}-keyboard-avoider`}
        >
          <Animated.View
            className="flex-1"
            style={contentStyle}
            onLayout={enter}
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
              <CredentialsFields
                form={form}
                passwordAutofill={passwordAutofill}
                passwordHint={passwordHint}
                onLoginInstead={onLoginInstead}
                testID={testID}
              />
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
    </Animated.View>
  );
}
