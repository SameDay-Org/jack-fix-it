import { router, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import type { ParamListBase } from "expo-router/react-navigation";
import { useEffect, useRef, type ComponentRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, moveAccessibilityFocus, Screen, StepProgress } from "@/components/ui";

import { useRequestFlowContext } from "./RequestFlowLayout";
import { useRequestDraft } from "./requestDraft";
import type { StepId } from "./steps";

export type StepScreenProps = {
  step: StepId;
  steps: readonly StepId[];
  title: string;
  /** One supporting line under the title. */
  support?: string;
  children: ReactNode;
  /** The step's one action (Continue, Send), pinned under the content, above the keyboard. */
  action: ReactNode;
  /** For steps that scroll to a field with an error. */
  scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>;
  /**
   * The title of the notice the server's refusal put on this step, while it shows. The step, still
   * mounted at its old scroll position under Review, scrolls back to the top where the notice is,
   * and screen readers hear it.
   */
  refusal?: string;
  testID: string;
};

/**
 * One step of the request flow: Back (on the first step it leaves the flow) and Cancel, the
 * progress ("Step 2 of 5"), the title and its line, the step's content, and its action pinned at
 * the bottom. The title is the screen's header; screen-reader focus lands on it once the step is
 * shown, and it is read with the progress.
 */
export function StepScreen({
  step,
  steps,
  title,
  support,
  children,
  action,
  scrollRef,
  refusal,
  testID,
}: StepScreenProps) {
  const { t } = useTranslation();
  const { top } = useSafeAreaInsets();
  const { close, sending } = useRequestFlowContext();
  const titleRef = useRef<ComponentRef<typeof Text>>(null);
  const index = steps.indexOf(step);
  const first = index === 0;
  const progress = t("request.progress", { current: index + 1, total: steps.length });
  useFocusTitleWhenShown(titleRef);
  const ownScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scroll = scrollRef ?? ownScrollRef;
  // Keyed on the refusal itself: a second send refused for the same reason scrolls up again.
  const refused = useRequestDraft((draft) => (draft.refusal?.step === step ? draft.refusal : null));
  useEffect(() => {
    if (!refused || !refusal) return;
    scroll.current?.scrollTo({ y: 0, animated: false });
    AccessibilityInfo.announceForAccessibility(refusal);
  }, [refused, refusal, scroll]);

  return (
    <Screen bar="light" testID={testID}>
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={top} className="flex-1">
        <View className="flex-1">
          <View className="gap-3 px-4 pt-2">
            <View className="flex-row items-center justify-between">
              <Button
                label={t("common.back")}
                variant="ghost"
                disabled={sending}
                onPress={() => (first ? close() : router.back())}
                className="-ml-5"
                testID="request-back"
              />
              {first ? null : (
                <Button
                  label={t("request.cancel")}
                  variant="ghost"
                  disabled={sending}
                  onPress={() => close()}
                  className="-mr-5"
                  testID="request-cancel"
                />
              )}
            </View>
            <StepProgress
              current={index + 1}
              total={steps.length}
              label={progress}
              testID="request-progress"
            />
          </View>
          <ScrollView
            ref={scroll}
            contentContainerClassName="gap-6 px-4 pb-6 pt-6"
            keyboardShouldPersistTaps="handled"
            testID={`${testID}-scroll`}
          >
            <View className="gap-2">
              <Text
                ref={titleRef}
                accessibilityRole="header"
                accessibilityLabel={`${progress}. ${title}`}
                className="text-title-1 text-navy-900"
              >
                {title}
              </Text>
              {support ? <Text className="text-body text-gray-500">{support}</Text> : null}
            </View>
            {children}
          </ScrollView>
          <View className="px-4 pb-4 pt-2">{action}</View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * Moves screen-reader focus to the title each time the stack has shown the step (a push, or a
 * return to it): the reader starts at the step's header and hears where it is in the flow.
 */
function useFocusTitleWhenShown(titleRef: RefObject<ComponentRef<typeof Text> | null>) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  useEffect(
    () =>
      navigation.addListener("transitionEnd", ({ data }) => {
        if (!data.closing) moveAccessibilityFocus(titleRef.current);
      }),
    [navigation, titleRef],
  );
}
