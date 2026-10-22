import { router, useFocusEffect, useNavigation, type Href } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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

export type PanelGeometry = {
  /** The panel's resting top edge, measured from the top of the content area. */
  restingTop: number;
  /** The status-bar strip above the content area, which the panel also covers. */
  topInset: number;
};

type Params = { reduceMotion: boolean };

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
  /** Rise, then navigate once; ignored while busy. Under Reduce Motion, navigate at once. */
  go: (href: Href) => void;
};

/**
 * The rise of Welcome's panel into the next screen. `go` runs the rise on the UI thread and
 * navigates when it settles; the route itself only fades in where the panel ended. When Welcome
 * is focused again (back from the destination) the panel lowers, and a navigation that fails or
 * does nothing lowers it too, so the screen is never left covered. `bar` flips when the panel's
 * top crosses the middle of the status-bar strip, in both directions, so the icons change at the
 * moment the panel reaches them. Under Reduce Motion there is no rise or parallax: the stack's
 * crossfade is the whole transition.
 */
export function usePanelTransition({ reduceMotion }: Params): PanelTransition {
  const { panelRiseMs } = tokens.motion;
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

  useAnimatedReaction(
    () => progress.value >= flipAt.value,
    (covered, previous) => {
      if (covered !== previous) runOnJS(setBar)(covered ? "light" : "hero");
    },
  );

  const clearSettleCheck = () => {
    if (settleCheck.current) clearTimeout(settleCheck.current);
    settleCheck.current = null;
  };

  const release = () => {
    busyRef.current = false;
    setBusy(false);
  };

  /**
   * Back to rest: the panel lowers (if it rose), and the actions take taps again once it is down,
   * not while they are still invisible near the top of the screen.
   */
  const rest = () => {
    clearSettleCheck();
    if (progress.value <= 0) {
      release();
      return;
    }
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

  const go = (href: Href) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (reduceMotion) {
      navigate(href);
      return;
    }
    // The completion callback is passed to withTiming directly so the Babel plugin makes it a
    // worklet (through a helper it would stay a JS function and fail on the UI thread). It eases
    // out over the token's duration: a deterministic end, so the navigation follows on time.
    progress.value = withTiming(1, { duration: panelRiseMs, easing: EASING }, (finished) => {
      if (finished) runOnJS(navigate)(href);
    });
  };

  // Focused again after the destination went away: the reverse of the rise. The focus effect
  // must keep its identity across renders, so it reads the latest `rest` through a ref.
  const restRef = useRef(rest);
  useEffect(() => {
    restRef.current = rest;
  });
  useFocusEffect(
    useCallback(() => {
      if (busyRef.current) restRef.current();
    }, []),
  );

  useEffect(() => clearSettleCheck, []);

  return { progress, travel, bar, busy, setGeometry, go };
}
