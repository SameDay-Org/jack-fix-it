import { useFocusEffect, useIsFocused, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import type { ParamListBase } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState, type ComponentRef, type RefObject } from "react";
import { BackHandler, Platform, type Text, type ViewStyle } from "react-native";
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
import {
  CONTENT_FROM,
  panelHandoffStore,
  panelProgress,
  panelTravel,
  usePanelHandoff,
} from "./panelHandoff";
import { pushesUnderRise } from "./panelRoute";

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
  /** Whether the screen sets the status bar: only while focused (not while prefetched). */
  ownsStatusBar: boolean;
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
  const { transitionMs, slidePx, panelRiseMs } = tokens.motion;
  const { xl } = tokens.radius;
  // Android, with the rise: the screen is on screen under the rising panel, so it rides it.
  const ridesPanel = animate && !reduceMotion && pushesUnderRise(Platform.OS);
  const focused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { bar: panelBar, phase } = usePanelHandoff();
  const visible = useSharedValue(animate ? 0 : 1);
  const entered = useRef(false);
  const laidOut = useRef(false);
  const appearing = useRef(false);
  const focusedRef = useRef(focused);
  const appearGuard = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const clearAppearGuard = () => {
    if (appearGuard.current) clearTimeout(appearGuard.current);
    appearGuard.current = null;
  };

  const start = () => {
    if (entered.current) return;
    entered.current = true;
    clearAppearGuard();
    setShown(true);
    visible.value = withTiming(1, timing, (finished) => {
      if (finished) runOnJS(focusTitle)();
    });
  };

  /**
   * Enters once laid out and on screen, unless the panel is still on its way up or the screen is
   * already leaving (a back during the rise must not be undone by the panel settling).
   */
  const tryStart = () => {
    if (!animate || entered.current || exitingRef.current) return;
    // Riding the panel, the screen shows with it (its opacity follows the panel); otherwise it
    // waits for the panel to settle.
    const panelSettled = ridesPanel || panelHandoffStore.getState().phase !== "rising";
    if (!laidOut.current || !panelSettled) return;
    if (appearing.current) {
      start();
      return;
    }
    // Pushed (focused) but the stack never reported it shown, as when the app was paused during
    // the push: enter after one more rise rather than stay invisible.
    if (focusedRef.current && !appearGuard.current) {
      appearGuard.current = setTimeout(() => {
        appearing.current = true;
        tryStartRef.current();
      }, panelRiseMs);
    }
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
    focusedRef.current = focused;
    if (focused) tryStartRef.current();
  }, [focused]);
  useEffect(() => clearAppearGuard, []);
  useEffect(() => {
    if (!animate) return;
    return panelHandoffStore.subscribe(() => tryStartRef.current());
  }, [animate]);
  // On screen: the stack is showing it (`transitionStart` comes with the native will-appear). A
  // React commit or even a layout event is earlier than that; a fade started on them ran while the
  // native screen was not attached yet, and the content popped in.
  useEffect(() => {
    if (!animate) return;
    const shownByStack = ({ data }: { data: { closing: boolean } }) => {
      if (data.closing) return;
      appearing.current = true;
      tryStartRef.current();
    };
    const offStart = navigation.addListener("transitionStart", shownByStack);
    const offEnd = navigation.addListener("transitionEnd", shownByStack); // a second chance
    return () => {
      offStart();
      offEnd();
    };
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

  const rootStyle = useAnimatedStyle(() => {
    if (!ridesPanel) return { opacity: visible.value };
    // The screen's top edge is the panel's, with its corners, and its content shows over the
    // second half of the rise: page and content arrive in the panel's own frames, on the UI
    // thread, however long the device takes to draw a frame.
    const p = panelProgress.value;
    const shownOnPanel = Math.min(1, Math.max(0, (p - CONTENT_FROM) / (1 - CONTENT_FROM)));
    return {
      opacity: visible.value * shownOnPanel,
      transform: [{ translateY: panelTravel.value * (1 - p) }],
      borderTopLeftRadius: xl * (1 - p),
      borderTopRightRadius: xl * (1 - p),
      overflow: "hidden",
    };
  });
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: reduceMotion ? 0 : slidePx * (1 - visible.value) }],
  }));

  return {
    rootStyle,
    contentStyle,
    enter,
    exit,
    // Once shown, the page keeps its color through the exit: under Reduce Motion the panel's bar
    // is still the hero's, and a navy page fading out was the empty-navy frame of #175.
    // Riding the panel the screen shows before the panel covers the bar: the bar follows the panel
    // until then.
    bar: !animate || (shown && phase !== "rising") ? "light" : panelBar,
    ownsStatusBar: !animate || focused,
    busy: animate && (!shown || exiting),
  };
}
