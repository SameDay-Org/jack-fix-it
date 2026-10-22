import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { BackHandler, type Text, type ViewStyle } from "react-native";
import {
  Easing,
  ReduceMotion,
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
  /** The content is leaving: it takes no taps, so nothing can navigate under the pending back. */
  busy: boolean;
};

/**
 * The destination's side of the panel rise: the content fades and slides up into the page the
 * panel became, screen-reader focus moves to the title, and going back (the Back button or
 * Android's hardware back) fades the content out before the route pops and Welcome lowers its
 * panel. Reached any other way, the content is simply there.
 *
 * The content's container must set `needsOffscreenAlphaCompositing`: Android otherwise applies the
 * fading opacity to each card and to its elevation shadow separately, and the cards turn into gray
 * blocks mid-fade. Under Reduce Motion the fade still runs (a dissolve is the reduced motion; only
 * the slide goes), so the destination crossfades in instead of popping.
 */
export function useContentTransition({
  animate,
  reduceMotion,
  titleRef,
}: Params): ContentTransition {
  const { transitionMs, slidePx } = tokens.motion;
  const visible = useSharedValue(animate ? 0 : 1);
  const entered = useRef(false);
  const exitingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // What runs after the exit. Kept in a ref: a JS function captured by the worklet callback would
  // cross to the UI thread as a remote function, and the callback only needs to say "done".
  const afterExitRef = useRef<(() => void) | null>(null);
  const timing = {
    duration: transitionMs,
    easing: Easing.out(Easing.cubic),
    reduceMotion: ReduceMotion.Never,
  };

  const focusTitle = () => moveAccessibilityFocus(titleRef.current);

  const enter = () => {
    if (!animate || entered.current) return;
    entered.current = true;
    visible.value = withTiming(1, timing, (finished) => {
      if (finished) runOnJS(focusTitle)();
    });
  };

  const afterExit = (finished: boolean) => {
    exitingRef.current = false;
    setBusy(false);
    const then = afterExitRef.current;
    afterExitRef.current = null;
    if (finished) then?.();
    // Interrupted: the content comes back rather than staying invisible over live controls.
    else visible.value = withTiming(1, timing);
  };

  const exit = (then: () => void) => {
    if (!animate) {
      then();
      return;
    }
    if (exitingRef.current) return;
    exitingRef.current = true;
    setBusy(true);
    afterExitRef.current = then;
    visible.value = withTiming(0, timing, (finished) => {
      runOnJS(afterExit)(finished === true);
    });
  };

  // Android's hardware back runs the same exit before popping, but only while this screen is the
  // focused one: a screen pushed on top (sign-up over Role) owns its own back. The listener reads
  // the latest `exit` through a ref, so the focus effect keeps its identity.
  const exitRef = useRef(exit);
  useEffect(() => {
    exitRef.current = exit;
  });
  useFocusEffect(
    useCallback(() => {
      if (!animate) return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        exitRef.current(backToPrevious);
        return true;
      });
      return () => subscription.remove();
    }, [animate]),
  );

  const style = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [{ translateY: reduceMotion ? 0 : slidePx * (1 - visible.value) }],
  }));

  return { style, enter, exit, busy };
}
