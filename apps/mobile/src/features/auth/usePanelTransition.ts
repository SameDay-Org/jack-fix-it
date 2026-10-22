import { router, useFocusEffect, useNavigation, type Href } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import type { SystemBar } from "@/components/ui";
import { tokens } from "@/theme";

import { setPanelBar, setRisePhase } from "./panelHandoff";
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
  const progress = useSharedValue(0);
  const travel = useSharedValue(0);
  const flipAt = useSharedValue(1);
  const [bar, setBar] = useState<SystemBar>("hero");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const settleCheck = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setGeometry = ({ restingTop, topInset }: PanelGeometry) => {
    const distance = restingTop + topInset;
    travel.value = distance;
    flipAt.value = distance > 0 ? (restingTop + topInset / 2) / distance : 1;
  };

  const flipBar = (covered: boolean) => {
    const next: SystemBar = covered ? "light" : "hero";
    setBar(next);
    setPanelBar(next);
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

  const release = () => {
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
    // Always assigned, even when the panel reads 0: a rise started in this same turn (a push that
    // threw right away) is not on the UI thread yet, and this replaces it. At 0 already, it ends
    // at once.
    progress.value = withTiming(0, { duration: panelRiseMs, easing: EASING }, (finished) => {
      if (finished) runOnJS(release)();
    });
  };

  const navigate = (href: Href) => {
    try {
      router.push(href);
    } catch {
      rest();
      return;
    }
    // A push that leaves Welcome focused did nothing (no such route, an interrupted
    // navigation): the panel must not stay up over a screen the user cannot use.
    settleCheck.current = setTimeout(() => {
      if (navigation.isFocused()) rest();
    }, panelRiseMs);
  };

  /** The panel covers the screen: the destination may show its content; on iOS, push it now. */
  const risen = (pushNow: Href | null) => {
    setRisePhase("risen");
    if (pushNow) navigate(pushNow);
  };

  const go = (href: Href) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    lastDestination.current = href;
    setPanelBar("hero"); // at rest: the hero's light icons, until the panel covers the bar
    if (reduceMotion) {
      risen(href);
      return;
    }
    setRisePhase("rising");
    const under = pushesUnderRise(Platform.OS);
    // The completion callback is passed to withTiming directly so the Babel plugin makes it a
    // worklet (through a helper it would stay a JS function and fail on the UI thread). It eases
    // out over the token's duration: a deterministic end, so the hand-off follows on time.
    progress.value = withTiming(1, { duration: panelRiseMs, easing: EASING }, (finished) => {
      if (finished) runOnJS(risen)(under ? null : href);
    });
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

  useEffect(
    () => () => {
      clearSettleCheck();
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    },
    [],
  );

  return { progress, travel, bar, busy, setGeometry, go };
}
