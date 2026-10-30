import { router, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import type { ParamListBase } from "expo-router/react-navigation";
import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, moveAccessibilityFocus, Screen, StepProgress } from "@/components/ui";
import { useContentTransition } from "@/features/auth";

import { useRequestFlowContext } from "./RequestFlowLayout";
import { useRequestDraft } from "./requestDraft";
import { flowRisen } from "./rise";
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
   * mounted at its old scroll position under Review, scrolls back to the top where the notice is.
   * The notice announces itself when it appears; a repeat refusal for the same reason leaves it
   * unchanged on screen, so that one is announced here.
   */
  refusal?: string;
  testID: string;
};

/**
 * One step of the request flow: Back (on the first step it leaves the flow) and Cancel, the
 * progress ("Step 2 of 5"), the title and its line, the step's content, and its action pinned at
 * the bottom. The title is the screen's header; screen-reader focus lands on it once the step is
 * shown, and it is read with the progress.
 *
 * The first step, opened by a category card (`flowRisen`), is the destination of Home's panel
 * rise (`useContentTransition`, as Role and Login are Welcome's): it rides the rising panel in, and
 * leaving it (Back, Cancel, Android's back) fades it out onto the panel, which then lowers.
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
  // Fixed for the flow's life: read once.
  const [risen] = useState(() => first && flowRisen());
  const reduceMotion = useReducedMotion();
  const entrance = useContentTransition({
    animate: risen,
    reduceMotion,
    titleRef,
    onHardwareBack: (exit) => close(exit),
  });
  useFocusTitleWhenShown(titleRef, risen);
  const leave = () => close(risen ? entrance.exit : undefined);
  const ownScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const scroll = scrollRef ?? ownScrollRef;
  // Keyed on the refusal itself: a second send refused for the same reason scrolls up again.
  const refused = useRequestDraft((draft) => (draft.refusal?.step === step ? draft.refusal : null));
  const refusalShown = useRef(false);
  useEffect(() => {
    if (!refused || !refusal) {
      refusalShown.current = false;
      return;
    }
    scroll.current?.scrollTo({ y: 0, animated: false });
    if (refusalShown.current) AccessibilityInfo.announceForAccessibility(refusal);
    refusalShown.current = true;
  }, [refused, refusal, scroll]);

  const body = (
    <Screen
      bar="light"
      statusBar={entrance.statusBar}
      ownsStatusBar={entrance.ownsStatusBar}
      testID={testID}
    >
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={top} className="flex-1">
        <Animated.View
          className="flex-1"
          style={risen ? entrance.contentStyle : undefined}
          onLayout={risen ? entrance.enter : undefined}
        >
          {/* The header and the action bar are opaque and drawn over the scroll view: Android draws
              its content past its frame, and a scrolled step showed through under the progress.
              The header's bottom padding keeps the content's cut edge off the progress; the
              content's top padding is that much shorter, so the step at rest does not move. */}
          <View className="z-10 gap-3 bg-gray-50 px-4 pb-2 pt-2">
            <View className="flex-row items-center justify-between">
              <Button
                label={t("common.back")}
                variant="ghost"
                disabled={sending}
                onPress={() => (first ? leave() : router.back())}
                className="-ml-5"
                testID="request-back"
              />
              {first ? null : (
                <Button
                  label={t("request.cancel")}
                  variant="ghost"
                  disabled={sending}
                  onPress={leave}
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
            contentContainerClassName="gap-6 px-4 pb-6 pt-4"
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
          <View className="z-10 bg-gray-50 px-4 pb-4 pt-2">{action}</View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Screen>
  );

  if (!risen) return body;
  // The whole screen fades over the panel; offscreen compositing keeps the cards' shadows from
  // fading on their own (see `useContentTransition`).
  return (
    <Animated.View
      className="flex-1"
      style={entrance.rootStyle}
      needsOffscreenAlphaCompositing
      pointerEvents={entrance.busy ? "none" : "auto"}
      testID={`${testID}-risen`}
    >
      {body}
    </Animated.View>
  );
}

/**
 * Moves screen-reader focus to the title each time the stack has shown the step (a push, or a
 * return to it): the reader starts at the step's header and hears where it is in the flow. A
 * risen step's entrance focuses it the first time, once its content is in; returns still do here.
 */
function useFocusTitleWhenShown(
  titleRef: RefObject<ComponentRef<typeof Text> | null>,
  risen: boolean,
) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  useEffect(() => {
    let returned = !risen;
    const offBlur = navigation.addListener("blur", () => {
      returned = true;
    });
    const offEnd = navigation.addListener("transitionEnd", ({ data }) => {
      if (!data.closing && returned) moveAccessibilityFocus(titleRef.current);
    });
    return () => {
      offBlur();
      offEnd();
    };
  }, [risen, navigation, titleRef]);
}
