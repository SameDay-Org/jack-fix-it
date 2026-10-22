import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useSession } from "@/api";
import { WordRotator } from "@/components/ui";
import { tokens } from "@/theme";

import { LaunchHero } from "./LaunchHero";
import { useLaunchIntro } from "./useLaunchIntro";

type LaunchIntroProps = {
  /** The first frame is final (every word measured): the moment to lift the native splash. */
  onReady: () => void;
  /** The exit finished; the caller unmounts the intro. */
  onDone: () => void;
};

/**
 * The branded start of every launch, drawn over the session gate: the navy hero with the rolling
 * word, then a short fade (and a slight scale-up, unless Reduce Motion) into whatever the gate
 * shows. Tapping anywhere skips it.
 */
export function LaunchIntro({ onReady, onDone }: LaunchIntroProps) {
  const { t } = useTranslation();
  const { status } = useSession();
  const reduceMotion = useReducedMotion();
  const [runDone, setRunDone] = useState(false);
  const runEnd = useCallback(() => setRunDone(true), []);
  const { phase, skip } = useLaunchIntro({ status, reduceMotion, runDone });
  const words = t("launch.words", { returnObjects: true });
  const {
    wordSwapIntervalMs,
    wordSwapTransitionMs,
    launchSwaps,
    launchExitMs,
    launchExitScale,
    launchMaxMs,
  } = tokens.motion;

  // The splash lifts when the first frame is final, or at the latest when the intro must end.
  // Until then the intro paints nothing: the native splash normally covers that frame, but a dev
  // client does not hold it, and what sits under the intro is the same navy (the gate's static
  // hero, or its navy frame), so the words never show before they are measured.
  const readyRef = useRef(false);
  const [shown, setShown] = useState(false);
  const ready = () => {
    if (readyRef.current) return;
    readyRef.current = true;
    setShown(true);
    onReady();
  };
  useEffect(() => {
    const id = setTimeout(ready, launchMaxMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a one-shot fallback
  }, []);

  const exit = useSharedValue(0);
  useEffect(() => {
    if (phase !== "exiting") return;
    exit.value = withTiming(
      1,
      { duration: launchExitMs, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(onDone)();
      },
    );
  }, [exit, launchExitMs, onDone, phase]);

  const exitStyle = useAnimatedStyle(() => ({
    opacity: shown ? 1 - exit.value : 0,
    transform: [{ scale: reduceMotion ? 1 : 1 + (launchExitScale - 1) * exit.value }],
  }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, exitStyle]}
      pointerEvents={phase === "exiting" ? "none" : "auto"}
      testID="launch-intro"
    >
      <Pressable accessible={false} onPress={skip} className="flex-1">
        <LaunchHero
          testID="launch-hero"
          skip={{ label: t("launch.skip"), onPress: skip }}
          word={
            <WordRotator
              words={words}
              type="display"
              className="text-green-500"
              intervalMs={wordSwapIntervalMs}
              transitionMs={wordSwapTransitionMs}
              swaps={launchSwaps}
              stopAt={0}
              onRunEnd={runEnd}
              onReady={ready}
              testID="launch-rotator"
            />
          }
        />
      </Pressable>
    </Animated.View>
  );
}
