import { useEffect, useRef } from "react";
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
  const { phase, skip } = useLaunchIntro({ status, reduceMotion });
  const words = t("launch.words", { returnObjects: true });
  const { wordSwapIntervalMs, wordSwapTransitionMs, launchExitMs, launchExitScale, launchMaxMs } =
    tokens.motion;

  // The splash lifts when the first frame is final, or at the latest when the intro must end.
  const readyRef = useRef(false);
  const ready = () => {
    if (readyRef.current) return;
    readyRef.current = true;
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
    opacity: 1 - exit.value,
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
              stopAt={0}
              onReady={ready}
              testID="launch-rotator"
            />
          }
        />
      </Pressable>
    </Animated.View>
  );
}
