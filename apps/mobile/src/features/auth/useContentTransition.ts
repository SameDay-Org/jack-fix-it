import { useFocusEffect, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import type { ParamListBase } from "expo-router/react-navigation";
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

import { moveAccessibilityFocus, type SystemBar } from "@/components/ui";
import { tokens } from "@/theme";

import { backToPrevious } from "./components/BackButton";
import { panelHandoffStore, usePanelHandoff } from "./panelHandoff";

type Params = {
  /** The screen was reached by Welcome's panel rise: it hands off from the panel, and back to it. */
  animate: boolean;
  reduceMotion: boolean;
  /** The screen's title; screen-reader focus lands on it once the content is in. */
  titleRef: RefObject<ComponentRef<typeof Text> | null>;
};

export type ContentTransition = {
  /** For a view around the whole screen (its page included): fades in over the panel, and out. */
  rootStyle: AnimatedStyle<ViewStyle>;
  /** For the content's container: slides into place as it fades (not under Reduce Motion). */
  contentStyle: AnimatedStyle<ViewStyle>;
  /** The content container's `onLayout`: the content can enter once it is laid out. */
  enter: () => void;
  /** Fades the screen out, then runs `then` (the navigation). At once when not animating. */
  exit: (then: () => void) => void;
  /** The system bar to show: the panel's until the content is in, then the page's. */
  bar: SystemBar;
  /** Not in yet, or leaving: the screen takes no taps. */
  busy: boolean;
};

/**
 * The destination's side of the panel rise. The screen can be mounted while the panel still rises
 * (Android pushes it as the rise starts); it stays see-through until both are true: it is laid out
 * and the panel has `risen` (from `panelHandoff`). Then its page, the panel's color over the
 * panel, fades in with the content sliding into place, so nothing but the content changes on
 * screen, and screen-reader focus moves to the title. Ready early, it waits for the panel; late,
 * the covered panel holds until it is ready. Until then the status bar follows the panel's. Going
 * back (the Back button or Android's hardware back) fades the screen out over the still-covered
 * panel before the route pops and Welcome lowers it. Under Reduce Motion the same fade is a
 * crossfade over Welcome, without the slide. Reached any other way, the screen is simply there.
 *
 * The root must set `needsOffscreenAlphaCompositing`: Android otherwise applies the fading opacity
 * to each card and to its elevation shadow separately, and the cards turn into gray blocks.
 */
export function useContentTransition({
  animate,
  reduceMotion,
  titleRef,
}: Params): ContentTransition {
  const { transitionMs, slidePx } = tokens.motion;
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { bar: panelBar } = usePanelHandoff();
  const visible = useSharedValue(animate ? 0 : 1);
  const entered = useRef(false);
  const laidOut = useRef(false);
  const appearing = useRef(false);
  const exitingRef = useRef(false);
  const [shown, setShown] = useState(!animate);
  const [exiting, setExiting] = useState(false);
  // What runs after the exit. Kept in a ref: a JS function captured by the worklet callback would
  // cross to the UI thread as a remote function, and the callback only needs to say "done".
  const afterExitRef = useRef<(() => void) | null>(null);
  // A dissolve is the reduced motion, so the fade runs under Reduce Motion too; only the slide goes.
  const timing = {
    duration: transitionMs,
    easing: Easing.out(Easing.cubic),
    reduceMotion: ReduceMotion.Never,
  };

  const focusTitle = () => moveAccessibilityFocus(titleRef.current);

  const start = () => {
    if (entered.current) return;
    entered.current = true;
    setShown(true);
    visible.value = withTiming(1, timing, (finished) => {
      if (finished) runOnJS(focusTitle)();
    });
  };

  /** Enters once laid out and on screen, unless the panel is still on its way up. */
  const tryStart = () => {
    const ready = laidOut.current && appearing.current;
    if (animate && ready && panelHandoffStore.getState().phase !== "rising") start();
  };

  const enter = () => {
    if (!animate || laidOut.current) return;
    laidOut.current = true;
    tryStart();
  };

  const afterExit = (finished: boolean) => {
    exitingRef.current = false;
    setExiting(false);
    const then = afterExitRef.current;
    afterExitRef.current = null;
    if (finished) then?.();
    // Interrupted: the screen comes back rather than staying invisible over live controls.
    else visible.value = withTiming(1, timing);
  };

  const exit = (then: () => void) => {
    if (!animate) {
      then();
      return;
    }
    if (exitingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    afterExitRef.current = then;
    visible.value = withTiming(0, timing, (finished) => {
      runOnJS(afterExit)(finished === true);
    });
  };

  // The panel settles after the screen is laid out (it was ready early): enter then. The listener
  // reads the latest `tryStart` through a ref, so it is subscribed once.
  const tryStartRef = useRef(tryStart);
  useEffect(() => {
    tryStartRef.current = tryStart;
  });
  useEffect(() => {
    if (!animate) return;
    return panelHandoffStore.subscribe(() => tryStartRef.current());
  }, [animate]);
  // On screen: the stack is showing it (`transitionStart` comes with the native will-appear). A
  // React commit or even a layout event is earlier than that; a fade started on them ran while the
  // native screen was not attached yet, and the content popped in.
  useEffect(() => {
    if (!animate) return;
    return navigation.addListener("transitionStart", ({ data }) => {
      if (data.closing) return;
      appearing.current = true;
      tryStartRef.current();
    });
  }, [animate, navigation]);

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

  const rootStyle = useAnimatedStyle(() => ({ opacity: visible.value }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: reduceMotion ? 0 : slidePx * (1 - visible.value) }],
  }));

  const settled = shown && !exiting;
  return {
    rootStyle,
    contentStyle,
    enter,
    exit,
    bar: !animate || settled ? "light" : panelBar,
    busy: animate && !settled,
  };
}
