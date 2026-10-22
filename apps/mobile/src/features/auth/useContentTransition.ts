import { useEffect, useRef, type ComponentRef, type RefObject } from "react";
import { BackHandler, type Text, type ViewStyle } from "react-native";
import {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from "react-native-reanimated";

import { moveAccessibilityFocus } from "@/components/ui";
import { tokens } from "@/theme";

import { backToPrevious } from "./components/BackButton";

type Params = {
  /** The screen was reached by Welcome's panel rise: its content enters, and leaves on back. */
  animate: boolean;
  reduceMotion: boolean;
  /** The screen's title; screen-reader focus lands on it once the content is in. */
  titleRef: RefObject<ComponentRef<typeof Text> | null>;
};

export type ContentTransition = {
  /** For the content's container: fades (and slides, unless Reduce Motion) in and out. */
  style: AnimatedStyle<ViewStyle>;
  /** The container's `onLayout`: the content enters once it is laid out, once. */
  enter: () => void;
  /** Fades the content out, then runs `then` (the navigation). At once when not animating. */
  exit: (then: () => void) => void;
};

/**
 * The destination's side of the panel rise: the content fades and slides up into the page the
 * panel became, screen-reader focus moves to the title, and going back (the Back button or
 * Android's hardware back) fades the content out before the route pops and Welcome lowers its
 * panel. Reached any other way, the content is simply there.
 */
export function useContentTransition({
  animate,
  reduceMotion,
  titleRef,
}: Params): ContentTransition {
  const { transitionMs, slidePx } = tokens.motion;
  const visible = useSharedValue(animate ? 0 : 1);
  const entered = useRef(false);
  const exiting = useRef(false);

  const focusTitle = () => moveAccessibilityFocus(titleRef.current);

  const enter = () => {
    if (!animate || entered.current) return;
    entered.current = true;
    visible.value = withTiming(
      1,
      { duration: transitionMs, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(focusTitle)();
      },
    );
  };

  const afterExit = (finished: boolean, then: () => void) => {
    exiting.current = false;
    if (finished) then();
  };

  const exit = (then: () => void) => {
    if (!animate) {
      then();
      return;
    }
    if (exiting.current) return;
    exiting.current = true;
    visible.value = withTiming(
      0,
      { duration: transitionMs, easing: Easing.out(Easing.cubic) },
      (finished) => {
        runOnJS(afterExit)(finished === true, then);
      },
    );
  };

  // Android's hardware back runs the same exit before popping; the listener is registered once
  // and reads the latest `exit` through a ref.
  const exitRef = useRef(exit);
  useEffect(() => {
    exitRef.current = exit;
  });
  useEffect(() => {
    if (!animate) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      exitRef.current(backToPrevious);
      return true;
    });
    return () => subscription.remove();
  }, [animate]);

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: reduceMotion ? 0 : slidePx * (1 - visible.value) }],
  }));

  return { style, enter, exit };
}
