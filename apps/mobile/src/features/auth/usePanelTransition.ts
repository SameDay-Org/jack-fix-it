import {
  router,
  unstable_useIsNavigating as useIsNavigating,
  useFocusEffect,
  useNavigation,
  type Href,
} from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import type { SystemBar } from "@/components/ui";
import { tokens } from "@/theme";

import { usePanelHandoffContext, type RisePhase } from "./panelHandoff";
import { pushesUnderRise } from "./panelRoute";

export type PanelGeometry = {
  /** The panel's resting top edge, measured from the top of the content area. */
  restingTop: number;
  /** The status-bar strip above the content area, which the panel also covers. */
  topInset: number;
};

type Params = {
  reduceMotion: boolean;
  /**
   * Where the panel can rise to. Prefetched (mounted, not shown) whenever Welcome is focused at
   * rest, so a push only has to attach a screen that is already built.
   */
  destinations: Href[];
};

const EASING = Easing.out(Easing.cubic);

export type PanelTransition = {
  /** 0 at rest, 1 when the panel covers the screen. Drives every style on the UI thread. */
  progress: SharedValue<number>;
  /** How far the panel's top edge travels, in dp: resting top plus the status-bar strip. */
  travel: SharedValue<number>;
  /** The system bar Welcome should show: light icons until the panel covers the strip. */
  bar: SystemBar;
  /** A rise (or a navigation) is under way: the panel's actions take no taps. */
  busy: boolean;
  setGeometry: (geometry: PanelGeometry) => void;
  /**
   * Rise and navigate once; ignored while busy. The push goes out as the rise starts on Android
   * and as it ends on iOS; under Reduce Motion, at once.
   */
  go: (href: Href) => void;
};

/**
 * The rise of Welcome's panel into the next screen. Both destinations are prefetched while Welcome
 * waits at rest (the first time after the launch intro, at most `motion.launchMaxMs`), so their
 * screens are built before any tap. `go` runs the rise on the UI thread and pushes the destination:
 * on Android as the rise starts, so it is on screen (see-through) before the panel settles; on iOS
 * as it ends (see `risenFromWelcome`). The phase and the bar go to `panelHandoff`, where the
 * destination reads them: it shows its content once the panel has `risen`. When Welcome is focused again (back from
 * the destination) the panel lowers, and a navigation that fails or does nothing lowers it too,
 * so the screen is never left covered. `bar` flips when the panel's top crosses the middle of the
 * status-bar strip, in both directions, so the icons change at the moment the panel reaches them.
 * Under Reduce Motion there is no rise or parallax: the destination crossfades over Welcome.
 */
export function usePanelTransition({ reduceMotion, destinations }: Params): PanelTransition {
  const { panelRiseMs, launchMaxMs } = tokens.motion;
  const navigation = useNavigation();
  // The auth flow's hand-off (see `panelHandoff`): the destination rides the same values.
  const { store, progress, travel, setProgress, setTravel } = usePanelHandoffContext();
  const setRisePhase = (phase: RisePhase) => store.setState({ phase });
  const setPanelBar = (next: SystemBar) => store.setState({ bar: next });
  const flipAt = useSharedValue(1);
  const [bar, setBar] = useState<SystemBar>("hero");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const settleCheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The router still has a navigation queued or rendering (see `settle`).
  const navigating = useIsNavigating();
  const navigatingRef = useRef(navigating);
  const settleWhenIdle = useRef(false);
  // Every rise and every lowering is a new generation: a completion from an older one (a rise
  // replaced by a back, a screen gone meanwhile) changes nothing.
  const generation = useRef(0);
  const mounted = useRef(true);
  const isCurrent = (startedIn: number) => mounted.current && startedIn === generation.current;

  const setGeometry = ({ restingTop, topInset }: PanelGeometry) => {
    const distance = restingTop + topInset;
    setTravel(distance);
    flipAt.value = distance > 0 ? (restingTop + topInset / 2) / distance : 1;
  };

  const flipBar = (covered: boolean) => {
    const next: SystemBar = covered ? "light" : "hero";
    setBar(next);
    setPanelBar(next);
    // Covering the status bar is the panel nearly settled: the rest of the ease is its last few
    // dp. The destination may start its content now, so it arrives as the panel lands rather than
    // a frame or two after.
    if (covered && store.getState().phase === "rising") setRisePhase("risen");
  };

  useAnimatedReaction(
    () => progress.value >= flipAt.value,
    (covered, previous) => {
      if (covered !== previous) runOnJS(flipBar)(covered);
    },
  );

  const clearSettleCheck = () => {
    if (settleCheck.current) clearTimeout(settleCheck.current);
    settleCheck.current = null;
    settleWhenIdle.current = false;
  };

  const prefetch = () => {
    if (busyRef.current) return;
    for (const href of destinations) router.prefetch(href);
  };
  const firstFocus = useRef(true);
  // The destination the last rise went to: the only one a return to rest has to build again (the
  // other is still prefetched, and prefetching it anew would rebuild it from scratch).
  const lastDestination = useRef<Href | null>(null);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const release = (startedIn: number) => {
    if (!isCurrent(startedIn)) return;
    busyRef.current = false;
    setBusy(false);
    if (lastDestination.current) router.prefetch(lastDestination.current);
    lastDestination.current = null;
  };

  /**
   * Back to rest: the panel lowers (if it rose), and the actions take taps again once it is down,
   * not while they are still invisible near the top of the screen.
   */
  const rest = () => {
    clearSettleCheck();
    setRisePhase("idle");
    const startedIn = ++generation.current;
    // Always assigned, even when the panel reads 0: a rise started in this same turn (a push that
    // threw right away) is not on the UI thread yet, and this replaces it. At 0 already, it ends
    // at once.
    setProgress(
      withTiming(0, { duration: panelRiseMs, easing: EASING }, (finished) => {
        if (finished) runOnJS(release)(startedIn);
      }),
    );
  };

  /**
   * A push that leaves Welcome focused did nothing (no such route, an interrupted navigation):
   * the panel must not stay up over a screen the user cannot use. But the router queues a push
   * and runs it after a render, behind whatever it is still building (a prefetched screen, right
   * after a sign-out or a back), so Welcome stays focused until then. Lowered meanwhile, the panel
   * left the destination arriving with nothing to ride: a screen on top, invisible, taking every
   * tap (#193). So the check waits until the router has nothing pending.
   */
  const settle = () => {
    settleCheck.current = null;
    if (!mounted.current || !busyRef.current) return;
    if (navigatingRef.current) {
      settleWhenIdle.current = true;
      return;
    }
    if (navigation.isFocused()) rest();
  };

  const navigate = (href: Href) => {
    try {
      router.push(href);
    } catch {
      rest();
      return;
    }
    settleCheck.current = setTimeout(settle, panelRiseMs);
  };

  /** The panel covers the screen: the destination may show its content; on iOS, push it now. */
  const risen = (pushNow: Href | null, startedIn: number) => {
    if (!isCurrent(startedIn)) return;
    setRisePhase("risen");
    if (pushNow) navigate(pushNow);
  };

  const go = (href: Href) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    lastDestination.current = href;
    setPanelBar("hero"); // at rest: the hero's light icons, until the panel covers the bar
    const startedIn = ++generation.current;
    if (reduceMotion) {
      risen(href, startedIn);
      return;
    }
    setRisePhase("rising");
    const under = pushesUnderRise(Platform.OS);
    // The completion callback is passed to withTiming directly so the Babel plugin makes it a
    // worklet (through a helper it would stay a JS function and fail on the UI thread). It eases
    // out over the token's duration: a deterministic end, so the hand-off follows on time.
    setProgress(
      withTiming(1, { duration: panelRiseMs, easing: EASING }, (finished) => {
        if (finished) runOnJS(risen)(under ? null : href, startedIn);
      }),
    );
    // After the rise has started, so a push that throws lowers a panel that is already moving.
    if (under) navigate(href);
  };

  // Focused again after the destination went away: the reverse of the rise. The focus effect
  // must keep its identity across renders, so it reads the latest `rest` through a ref.
  const restRef = useRef(rest);
  useEffect(() => {
    restRef.current = rest;
  });
  const prefetchRef = useRef(prefetch);
  useEffect(() => {
    prefetchRef.current = prefetch;
  });
  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  });
  // The settle check came while the router was busy: it runs once the router is done.
  useEffect(() => {
    navigatingRef.current = navigating;
    if (navigating || !settleWhenIdle.current) return;
    settleWhenIdle.current = false;
    settleRef.current();
  }, [navigating]);
  useFocusEffect(
    useCallback(() => {
      if (busyRef.current) {
        restRef.current(); // prefetches again once the panel is down
      } else if (firstFocus.current) {
        // Not while the launch intro plays over Welcome: building two screens then could cost it
        // frames on a slow phone. A tap before this simply waits a little longer for its screen.
        prefetchTimer.current = setTimeout(() => prefetchRef.current(), launchMaxMs);
      } else {
        prefetchRef.current();
      }
      firstFocus.current = false;
    }, [launchMaxMs]),
  );

  // A new Welcome starts at rest, whatever the hand-off held, and leaves nothing running behind it.
  useEffect(() => {
    mounted.current = true;
    setProgress(0);
    store.setState({ phase: "idle", bar: "hero" });
    return () => {
      mounted.current = false;
      generation.current += 1;
      cancelAnimation(progress);
      clearSettleCheck();
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    };
  }, [progress, setProgress, store]);

  return { progress, travel, bar, busy, setGeometry, go };
}
