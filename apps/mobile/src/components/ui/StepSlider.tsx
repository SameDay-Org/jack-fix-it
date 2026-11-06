import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { tokens } from "@/theme";

export type StepSliderProps<Key extends string> = {
  /** The pane on screen. A change slides the one before it out and this one in. */
  stepKey: Key;
  /** Where the new pane comes from: 1, the right (the next step); -1, the left (a step back). */
  direction: 1 | -1;
  /**
   * Renders a pane. Called for the pane on its way out too, so its fields keep their state while
   * it leaves instead of going blank.
   */
  renderStep: (stepKey: Key) => ReactNode;
  /** The pane for `stepKey` is in place after a transition. Not called for the first pane. */
  onSettled?: (stepKey: Key) => void;
  testID?: string;
};

type Shown<Key> = { current: Key; leaving: Key | null };

const SLIDE = {
  duration: tokens.motion.stepSlideMs,
  easing: Easing.out(Easing.cubic),
};
// The fade is the reduced-motion transition: it must play when the OS asks for less motion.
const FADE = { duration: tokens.motion.transitionMs, reduceMotion: ReduceMotion.Never };
/** The slide's travel before the slider has been laid out (its first transition comes later). */
const FALLBACK_TRAVEL = 320;

/**
 * One pane at a time, with a transition between them that leaves the rest of the screen alone:
 * the pane on its way out slides to the side and fades while the next one arrives from the
 * other side, and the slider's height glides from the one to the other so what sits below moves
 * with it instead of jumping. The leaving pane stays mounted (absolute, over the same width,
 * taking no taps, hidden from assistive technology) until it is gone, so a form keeps its text as
 * it goes. Under Reduce Motion the panes crossfade in place and the height changes at once.
 */
export function StepSlider<Key extends string>({
  stepKey,
  direction,
  renderStep,
  onSettled,
  testID,
}: StepSliderProps<Key>) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState<Shown<Key>>({ current: stepKey, leaving: null });
  // A new key starts a transition from the pane that was current, even mid-transition: the pane
  // that was leaving is simply dropped.
  if (shown.current !== stepKey) setShown({ current: stepKey, leaving: shown.current });

  const paneWidth = useSharedValue(0);
  const settledHeight = useSharedValue(0);
  const height = useSharedValue(0);
  const heightLocked = useSharedValue(0);
  const enterX = useSharedValue(0);
  const enterOpacity = useSharedValue(1);
  const leaveX = useSharedValue(0);
  const leaveOpacity = useSharedValue(1);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  const settle = (key: Key) => {
    heightLocked.value = 0;
    setShown((state) => (state.current === key ? { current: key, leaving: null } : state));
    onSettledRef.current?.(key);
  };

  useLayoutEffect(() => {
    if (shown.leaving === null) return;
    const arriving = shown.current;
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(settle)(arriving);
    };
    if (reduceMotion) {
      enterX.value = 0;
      leaveX.value = 0;
      heightLocked.value = 0;
      enterOpacity.value = 0;
      leaveOpacity.value = 1;
      enterOpacity.value = withTiming(1, FADE);
      leaveOpacity.value = withTiming(0, FADE, finish);
      return;
    }
    const travel = direction * (paneWidth.value || FALLBACK_TRAVEL);
    height.value = settledHeight.value;
    heightLocked.value = 1;
    enterX.value = travel;
    enterOpacity.value = 0;
    leaveX.value = 0;
    leaveOpacity.value = 1;
    enterX.value = withTiming(0, SLIDE);
    enterOpacity.value = withTiming(1, SLIDE);
    leaveX.value = withTiming(-travel, SLIDE);
    leaveOpacity.value = withTiming(0, SLIDE, finish);
    // The slider's own values are stable; `settle` reads nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a transition starts once per `shown`
  }, [shown, direction, reduceMotion]);

  const measureSlider = (event: LayoutChangeEvent) => {
    paneWidth.value = event.nativeEvent.layout.width;
  };
  // The current pane's height: the slider glides to it while a transition holds the height, and
  // keeps it as the height to glide from next time.
  const measureCurrent = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    settledHeight.value = measured;
    if (heightLocked.value) height.value = withTiming(measured, SLIDE);
  };

  const sliderStyle = useAnimatedStyle(() => ({
    height: heightLocked.value ? height.value : "auto",
  }));
  const currentStyle = useAnimatedStyle(() => ({
    opacity: enterOpacity.value,
    transform: [{ translateX: enterX.value }],
  }));
  const leavingStyle = useAnimatedStyle(() => ({
    opacity: leaveOpacity.value,
    transform: [{ translateX: leaveX.value }],
  }));

  return (
    <Animated.View
      style={[styles.slider, sliderStyle]}
      onLayout={measureSlider}
      testID={testID}
    >
      {shown.leaving !== null ? (
        <Animated.View
          key={shown.leaving}
          style={[styles.leaving, leavingStyle]}
          pointerEvents="none"
          needsOffscreenAlphaCompositing
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={testID && `${testID}-leaving`}
        >
          {renderStep(shown.leaving)}
        </Animated.View>
      ) : null}
      <Animated.View
        key={shown.current}
        style={currentStyle}
        onLayout={measureCurrent}
        needsOffscreenAlphaCompositing
        testID={testID && `${testID}-current`}
      >
        {renderStep(shown.current)}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slider: { overflow: "hidden" },
  leaving: { position: "absolute", top: 0, left: 0, right: 0 },
});
