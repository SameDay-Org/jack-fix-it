import { useEffect, useRef, useState } from "react";
import {
  BackHandler,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Easing,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { tokens } from "@/theme";

/** Settles in about 300 ms with a hint of overshoot: the card is set down, not dropped. */
const FOCUS_SPRING = { damping: 24, stiffness: 240, mass: 1 } as const;
/** Under Reduce Motion: a fade out, the jump while nothing shows, a fade in; each half this long. */
const FADE_HALF_MS = tokens.motion.transitionMs;
const SLIDE = tokens.motion.slidePx;
/** The least room above the centered card, so it never touches the header. */
const TOP_GAP = 8;

type Geometry = { cardTop: number; cardHeight: number; viewport: number; scrollY: number };

/**
 * The Account card's focus mode (#293): `enter` sends the card from where it sits in the list to
 * the middle of the free area (above `bottomRoom`) while everything else moves away; `exit` (also
 * the Android back gesture while the screen is focused) brings it all back. State drives it: the
 * animation follows `inFocus` in an effect, so the shared values are only written outside render.
 *
 * Under Reduce Motion nothing travels: the card fades out, moves while invisible and fades in, and
 * the rest only fades.
 */
export function useCardFocus({
  bottomRoom,
  screenFocused,
}: {
  bottomRoom: number;
  screenFocused: boolean;
}) {
  // Reanimated reads the system setting once at app start, so this never changes while mounted.
  const reduceMotion = useReducedMotion();
  const [inFocus, setInFocus] = useState(false);
  /** 0 at rest, 1 in focus. */
  const progress = useSharedValue(0);
  /** How far the card travels down to the middle, in dp. */
  const travel = useSharedValue(0);
  const geometry = useRef<Geometry>({ cardTop: 0, cardHeight: 0, viewport: 0, scrollY: 0 });

  useEffect(() => {
    const to = inFocus ? 1 : 0;
    progress.value = reduceMotion
      ? withTiming(to, {
          duration: FADE_HALF_MS * 2,
          easing: Easing.linear,
          // This fade IS the reduced-motion path: the default would skip it to its end.
          reduceMotion: ReduceMotion.Never,
        })
      : withSpring(to, FOCUS_SPRING);
  }, [inFocus, reduceMotion, progress]);

  useEffect(() => {
    if (!inFocus || !screenFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setInFocus(false);
      return true;
    });
    return () => subscription.remove();
  }, [inFocus, screenFocused]);

  const enter = () => {
    const { cardTop, cardHeight, viewport, scrollY } = geometry.current;
    const target = Math.max(TOP_GAP, (viewport - bottomRoom - cardHeight) / 2);
    travel.value = target - (cardTop - scrollY);
    setInFocus(true);
  };
  const exit = () => setInFocus(false);

  const onCardLayout = (event: LayoutChangeEvent) => {
    geometry.current.cardTop = event.nativeEvent.layout.y;
    geometry.current.cardHeight = event.nativeEvent.layout.height;
  };
  const onViewportLayout = (event: LayoutChangeEvent) => {
    geometry.current.viewport = event.nativeEvent.layout.height;
  };
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    geometry.current.scrollY = event.nativeEvent.contentOffset.y;
  };

  const cardStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (reduceMotion) {
      return {
        opacity: Math.abs(1 - 2 * p),
        transform: [{ translateY: p >= 0.5 ? travel.value : 0 }],
      };
    }
    return { opacity: 1, transform: [{ translateY: p * travel.value }] };
  });

  // What gives way to the card: it fades, and (with motion) drops a little.
  const awayStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const opacity = interpolate(p, reduceMotion ? [0, 0.5] : [0, 1], [1, 0], Extrapolation.CLAMP);
    const drop = reduceMotion ? 0 : interpolate(p, [0, 1], [0, SLIDE * 2], Extrapolation.CLAMP);
    return { opacity, transform: [{ translateY: drop }] };
  });

  // The header's title gives way to Back in place.
  const titleStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const opacity = interpolate(p, reduceMotion ? [0, 0.5] : [0, 1], [1, 0], Extrapolation.CLAMP);
    const shift = reduceMotion ? 0 : interpolate(p, [0, 1], [0, SLIDE], Extrapolation.CLAMP);
    return { opacity, transform: [{ translateX: shift }] };
  });

  // What only focus mode shows (Back, the gesture hint) arrives as the card settles.
  const focusStyle = useAnimatedStyle(() => {
    const p = progress.value;
    const opacity = interpolate(p, reduceMotion ? [0.5, 1] : [0, 1], [0, 1], Extrapolation.CLAMP);
    const shift = reduceMotion ? 0 : interpolate(p, [0, 1], [-SLIDE, 0], Extrapolation.CLAMP);
    return { opacity, transform: [{ translateX: shift }] };
  });

  // The gesture hint under the card: it only fades (a style per view: Jest drives one view each).
  const hintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      progress.value,
      reduceMotion ? [0.5, 1] : [0, 1],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return {
    inFocus,
    enter,
    exit,
    onCardLayout,
    onViewportLayout,
    onScroll,
    cardStyle,
    awayStyle,
    titleStyle,
    focusStyle,
    hintStyle,
    /** How long the way in or out takes, near enough, for moving screen-reader focus after it. */
    settleMs: FADE_HALF_MS * 2,
  };
}
