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
import { CONTENT_FROM, usePanelHandoff, usePanelHandoffContext } from "./panelHandoff";
import { pushesUnderRise } from "./panelRoute";

type Guard = RefObject<ReturnType<typeof setTimeout> | null>;

const clearGuard = (guard: Guard) => {
  if (guard.current) clearTimeout(guard.current);
  guard.current = null;
};

/** How much of a screen riding the panel shows at progress `p`: over the rise's second half. */
const shownOnPanel = (p: number) => {
  "worklet";
  return Math.min(1, Math.max(0, (p - CONTENT_FROM) / (1 - CONTENT_FROM)));
};

type Params = {
  /** The screen was reached by Welcome's panel rise: it hands off from the panel, and back to it. */
  animate: boolean;
  reduceMotion: boolean;
  /** The screen's title; screen-reader focus lands on it once the content is in. */
  titleRef: RefObject<ComponentRef<typeof Text> | null>;
  /**
   * What Android's hardware back does with the exit, for a screen that decides how it is left (the
   * request flow's first step asks before discarding a draft). By default: the exit, then back.
   */
  onHardwareBack?: (exit: (then: () => void) => void) => void;
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
  /**
   * The status bar style (the page itself is always the light page): the panel's until the page
   * covers the bar, then the page's.
   */
  statusBar: SystemBar;
  /** Whether the screen sets the status bar: only while focused (not while prefetched). */
  ownsStatusBar: boolean;
  /** Not in yet, still riding a rising panel, or leaving: the screen takes no taps. */
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
 * Whatever the signals do, the focused screen never stays an invisible page on top (#193): if the
 * panel goes back down under it, it stops riding and fades in on its own; `motion.handoffMaxMs`
 * after it is focused it is in on its own, whatever the panel is doing, with the page's status
 * bar; and an exit whose navigation has not taken it away within that bound fades it back in,
 * on its own too, at once or as soon as it is focused again.
 *
 * The root must set `needsOffscreenAlphaCompositing`: Android otherwise applies the fading opacity
 * to each card and to its elevation shadow separately, and the cards turn into gray blocks.
 */
export function useContentTransition({
  animate,
  reduceMotion,
  titleRef,
  onHardwareBack,
}: Params): ContentTransition {
  const { transitionMs, slidePx, panelRiseMs, handoffMaxMs } = tokens.motion;
  const { xl } = tokens.radius;
  // Android, with the rise: the screen is on screen under the rising panel, so it rides it.
  const ridesPanel = animate && !reduceMotion && pushesUnderRise(Platform.OS);
  // 1 while the panel carries the screen; 0 once it does not; between the two while it glides off
  // it from the panel's progress at that moment, `leftAt` (see `standAlone`).
  const riding = useSharedValue(ridesPanel ? 1 : 0);
  const leftAt = useSharedValue(-1);
  const focused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  const { bar: panelBar, phase } = usePanelHandoff();
  const {
    store: handoffStore,
    progress: panelProgress,
    travel: panelTravel,
  } = usePanelHandoffContext();
  const visible = useSharedValue(animate ? 0 : 1);
  const entered = useRef(false);
  const laidOut = useRef(false);
  const appearing = useRef(false);
  const focusedRef = useRef(focused);
  const appearGuard: Guard = useRef(null);
  const enterGuard: Guard = useRef(null);
  const exitGuard: Guard = useRef(null);
  // Leaving: from the exit's start until the navigation takes the screen away (or `exitGuard`
  // brings it back).
  const exitingRef = useRef(false);
  // An exit whose navigation did not take the screen away within `handoffMaxMs`: it comes back,
  // at once if focused, otherwise as soon as it is focused again.
  const stranded = useRef(false);
  const carried = useRef(ridesPanel);
  const [shown, setShown] = useState(!animate);
  const [exiting, setExiting] = useState(false);
  // `carried`, as render state: riding a panel that is still rising, the screen takes no taps.
  const [onPanel, setOnPanel] = useState(ridesPanel);
  // Faded in on its own (not riding the panel): the page covers the bar, whatever the phase.
  const [standing, setStanding] = useState(false);
  // Faded out at the end of an exit: the bar is what is under the screen's again.
  const [faded, setFaded] = useState(false);
  // What runs after the exit. Kept in a ref: a JS function captured by the worklet callback would
  // cross to the UI thread as a remote function, and the callback only needs to say "done".
  const afterExitRef = useRef<(() => void) | null>(null);
  // A dissolve is the reduced motion, so the fade runs under Reduce Motion too; only the slide goes.
  const timing = {
    duration: transitionMs,
    easing: Easing.out(Easing.cubic),
    reduceMotion: ReduceMotion.Never,
  };

  // Once: a fade restarted by a fail-safe must not announce the title a second time.
  const titleFocused = useRef(false);
  /** Faded in: focus moves to the title (once), and a page on its own now covers the bar. */
  const arrived = () => {
    if (!carried.current) setStanding(true);
    if (titleFocused.current) return;
    titleFocused.current = true;
    moveAccessibilityFocus(titleRef.current);
  };

  /** Fades the screen in, from the opacity it is at. */
  const fadeIn = () => {
    visible.value = withTiming(1, timing, (finished) => {
      if (finished) runOnJS(arrived)();
    });
  };

  const clearAppearGuard = () => clearGuard(appearGuard);

  const start = () => {
    if (entered.current) return;
    entered.current = true;
    clearAppearGuard();
    setShown(true);
    fadeIn();
  };

  /**
   * The panel no longer carries the screen: it went back down under it, or never finished
   * rising. Riding it then, the screen would sit at the panel's opacity, invisible over Welcome
   * yet taking its taps (#193). It shows on its own instead, over Welcome: not in yet, `start`
   * fades it in at its place. In, it glides off the panel over one fade, its top edge and opacity
   * going on from where the panel had them to the risen page's (no jump, no dip), whatever the
   * panel does meanwhile.
   */
  const standAlone = () => {
    if (!carried.current) return;
    carried.current = false;
    setOnPanel(false);
    if (!entered.current) {
      riding.value = 0; // nothing of it shows yet
      return;
    }
    leftAt.value = panelProgress.value;
    riding.value = withTiming(0, timing, (finished) => {
      if (finished) runOnJS(arrived)();
    });
  };

  /** The fail-safes' way in: now, on its own. */
  const enterNow = () => {
    standAlone();
    appearing.current = true;
    start();
  };

  /**
   * Focused for `handoffMaxMs`: whatever held it up (signals that never came, or a rise that
   * stalled under content already fading in on it), it is in, on its own, and takes taps.
   */
  const forceEnter = () => {
    enterGuard.current = null;
    if (exitingRef.current || !focusedRef.current) return;
    if (entered.current) standAlone();
    else enterNow();
  };

  // The screen comes back rather than staying invisible over live controls, and takes taps. It
  // comes back on its own, whatever the panel did meanwhile (it may have gone down under it):
  // left before its content was in (a back during the rise), it enters now.
  const comeBack = () => {
    exitingRef.current = false;
    stranded.current = false;
    clearGuard(exitGuard);
    setExiting(false);
    setFaded(false);
    if (!entered.current) {
      enterNow();
      return;
    }
    standAlone();
    fadeIn();
  };

  /**
   * Enters once laid out and on screen, unless the panel is still on its way up or the screen is
   * already leaving (a back during the rise must not be undone by the panel settling).
   */
  const tryStart = () => {
    if (!animate) return;
    if (exitingRef.current) {
      // An exit that never took the screen away, and it is the focused screen: it comes back.
      if (stranded.current && focusedRef.current) comeBack();
      return;
    }
    // Focused with the panel at rest: Welcome lowered it, so nothing carries this screen.
    if (focusedRef.current && handoffStore.getState().phase === "idle") standAlone();
    if (entered.current) return;
    // Riding the panel, the screen shows with it (its opacity follows the panel); otherwise it
    // waits for the panel to settle.
    const panelSettled = ridesPanel || handoffStore.getState().phase !== "rising";
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
    const then = afterExitRef.current;
    afterExitRef.current = null;
    if (!finished) {
      comeBack(); // interrupted
      return;
    }
    setFaded(true);
    // Still leaving (no taps) until the navigation takes the screen away. One that never does
    // (a back that went nowhere) must not leave it invisible on top, now or once it is focused
    // again (blurred meanwhile). Armed before the navigation runs, in case that throws.
    exitGuard.current = setTimeout(() => {
      exitGuard.current = null;
      stranded.current = true;
      tryStartRef.current();
    }, handoffMaxMs);
    then?.();
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
  const forceEnterRef = useRef(forceEnter);
  useEffect(() => {
    forceEnterRef.current = forceEnter;
  });
  // Focused, it is the screen the user sees: whatever the panel or the stack report, it is in on
  // its own within `handoffMaxMs` (plus its fade) and takes taps, never an invisible page on top.
  // Armed on every focus: content already fading in on a panel that stalled is not in yet.
  useEffect(() => {
    focusedRef.current = focused;
    if (!focused) {
      clearGuard(enterGuard);
      return;
    }
    tryStartRef.current();
    if (animate && !enterGuard.current)
      enterGuard.current = setTimeout(() => forceEnterRef.current(), handoffMaxMs);
  }, [animate, focused, handoffMaxMs]);
  useEffect(() => () => [appearGuard, enterGuard, exitGuard].forEach(clearGuard), []);
  useEffect(() => {
    if (!animate) return;
    return handoffStore.subscribe(() => tryStartRef.current());
  }, [animate, handoffStore]);
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
  const onHardwareBackRef = useRef(onHardwareBack);
  useEffect(() => {
    exitRef.current = exit;
    onHardwareBackRef.current = onHardwareBack;
  });
  useFocusEffect(
    useCallback(() => {
      if (!animate) return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        const exitThen = (then: () => void) => exitRef.current(then);
        if (onHardwareBackRef.current) onHardwareBackRef.current(exitThen);
        else exitThen(backToPrevious);
        return true;
      });
      return () => subscription.remove();
    }, [animate]),
  );

  const rootStyle = useAnimatedStyle(() => {
    if (!ridesPanel) return { opacity: visible.value };
    // The screen's top edge is the panel's, with its corners, and its content shows over the
    // second half of the rise: page and content arrive in the panel's own frames, on the UI
    // thread, however long the device takes to draw a frame. Standing alone, it is the risen panel
    // (`riding` between the two while it glides off the panel, from where the panel left it).
    const from = leftAt.value < 0 ? panelProgress.value : leftAt.value;
    const p = 1 - riding.value * (1 - from);
    return {
      opacity: visible.value * shownOnPanel(p),
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
    // is still the hero's, and a navy page fading out was the empty-navy frame of #175. Faded out,
    // what shows is under the screen: on iOS its own card, the page's color; on Android (a
    // transparent modal) the panel, or Welcome's hero when the panel went down or, under Reduce
    // Motion, never rose: the panel's bar. Riding the panel the screen shows before the panel
    // covers the bar: the bar follows the panel until then. Faded in on its own, the page covers
    // the bar whatever the phase.
    statusBar:
      !animate ||
      (shown && (faded ? !pushesUnderRise(Platform.OS) : standing || phase !== "rising"))
        ? "light"
        : panelBar,
    ownsStatusBar: !animate || focused,
    busy: animate && (!shown || exiting || (onPanel && phase === "rising")),
  };
}
